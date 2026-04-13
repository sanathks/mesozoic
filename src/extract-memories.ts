/**
 * Background memory extraction using the configured side model.
 *
 * After each agent response, if the user message contains memory-worthy signals,
 * fire a lightweight Gemma call to extract and save anything worth keeping.
 * Non-blocking — response is already sent to Slack before this runs.
 *
 * Gemma handles the task well (evaluated: 8/8 with correct prompting):
 * - Correctly identifies preferences, facts, decisions, explicit requests
 * - Correctly skips questions, tasks, smalltalk
 * - ~300ms–2s locally, zero cost
 */

import { insertMemory } from "./db/memory-db.js";
import { loadRuntimeConfig, resolveSideModelEndpoint } from "./config.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_TOKENS = 300;

function getSideModel() {
  return resolveSideModelEndpoint(loadRuntimeConfig());
}

// ─── Signal detection (pre-filter — zero cost) ────────────────────────────────

const MEMORY_SIGNALS: RegExp[] = [
  /\b(remember|don'?t forget|keep in mind|make a note|note that|pin this)\b/i,
  /\b(i (always|usually|prefer|like|hate|love|use|don'?t|never|want))\b/i,
  /\b(always|never|every time|don'?t ever)\b/i,
  /\b(my (name|team|project|company|boss|stack|setup|workflow|role|job))\b/i,
  /\b(i'?m (a |an |the |working|building|using|running))\b/i,
  /\b(i work (at|for|on|with))\b/i,
  /\b(we (decided|agreed|chose|picked|went with|are using))\b/i,
  /\b(going with|let'?s (use|go with|stick with))\b/i,
  /\b(use (tabs|spaces|typescript|javascript|python|postgres|mysql|redis|docker))\b/i,
];

export function hasMemorySignals(text: string): boolean {
  return MEMORY_SIGNALS.some((re) => re.test(text));
}

// ─── Extraction prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a memory extraction agent. Given a conversation exchange, decide if anything is worth saving to long-term memory.

Respond with ONLY valid JSON, no explanation:

If worth saving:
{"save": true, "content": "concise fact to remember", "category": "preference|fact|project|person|decision|general", "pinned": false}

Set pinned=true ONLY when the user explicitly asks to remember something using phrases like "remember this", "don't forget", "keep in mind", "never do X", "always do Y".

If nothing is worth saving:
{"save": false}

Save: preferences, personal facts, project context, people info, decisions, explicit memory requests.
Do NOT save: questions, task requests, bug fixes, general knowledge queries, one-off events.`;

function buildPrompt(userMessage: string, assistantResponse: string): string {
  return `User: "${userMessage}"\nAssistant: "${assistantResponse.slice(0, 300)}"`;
}

// ─── Gemma call ───────────────────────────────────────────────────────────────

interface ExtractionResult {
  save: boolean;
  content?: string;
  category?: string;
  pinned?: boolean;
}

async function callSideModel(
  userMessage: string,
  assistantResponse: string,
): Promise<ExtractionResult | null> {
  const { baseUrl, modelId, apiKey } = getSideModel();

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(userMessage, assistantResponse) },
      ],
      temperature: 0,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(15_000), // 15s max
  });

  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as any;
  const raw = data.choices?.[0]?.message?.content ?? "";

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  return JSON.parse(match[0]) as ExtractionResult;
}

// ─── Per-thread coalescing ────────────────────────────────────────────────────

interface PendingJob {
  userMessage: string;
  assistantResponse: string;
  threadId: string;
}

const inProgress = new Set<string>();
const pending = new Map<string, PendingJob>();

async function runExtraction(job: PendingJob): Promise<void> {
  try {
    const result = await callSideModel(job.userMessage, job.assistantResponse);

    if (!result?.save || !result.content?.trim()) {
      console.log(`[extract] nothing to save thread=${job.threadId}`);
      return;
    }

    const id = insertMemory(
      result.content.trim(),
      result.category || "general",
      job.threadId,
      result.pinned === true,
    );

    const pin = result.pinned ? " 📌" : "";
    if (process.env.MESO_QUIET !== "1") console.log(`[extract] saved [id:${id}]${pin} (${result.category}): ${result.content.trim()}`);
  } catch (err) {
    // Best-effort — never throw
    if (process.env.MESO_QUIET !== "1") console.error(`[extract] failed thread=${job.threadId}:`, err);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fire-and-forget memory extraction after an agent response.
 * Skipped entirely if:
 *   - the agent already called memory.save this turn (alreadySaved=true)
 *   - No memory-worthy signals in the user message
 *   - Ollama/Gemma is unavailable
 */
export function scheduleExtraction(
  userMessage: string,
  assistantResponse: string,
  threadId: string,
  alreadySaved: boolean,
): void {
  // Gate 1: already saved — nothing to extract
  if (alreadySaved) return;

  // Gate 2: no signals — skip Gemma call entirely
  if (!hasMemorySignals(userMessage)) return;

  if (process.env.MESO_QUIET !== "1") console.log(`[extract] signal detected thread=${threadId}`);

  const job: PendingJob = { userMessage, assistantResponse, threadId };

  // Coalesce: stash if already running for this thread
  if (inProgress.has(threadId)) {
    pending.set(threadId, job);
    return;
  }

  inProgress.add(threadId);

  runExtraction(job)
    .then(async () => {
      const next = pending.get(threadId);
      pending.delete(threadId);
      inProgress.delete(threadId);

      if (next) {
        inProgress.add(threadId);
        await runExtraction(next);
        inProgress.delete(threadId);
      }
    })
    .catch(() => {
      pending.delete(threadId);
      inProgress.delete(threadId);
    });
}
