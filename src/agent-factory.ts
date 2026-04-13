/**
 * Shared agent setup used by both Slack and TUI runners.
 */

import fs from "node:fs";
import path from "node:path";
import { checkBashCommand, checkFilePath } from "./guardrails.js";
import { loadTodayMemories } from "./tools/memory.js";
import { resolveAgentPath } from "./core/storage.js";

// ─── Guardrail extension ──────────────────────────────────────────────────────

export function createGuardrailExtension() {
  const agentLabel = process.env.MESO_AGENT_ID || "agent";
  return (pi: any) => {
    pi.on("tool_call", async (event: any) => {
      if (event.toolName === "bash" && event.input?.command) {
        const result = await checkBashCommand(event.input.command);
        if (result.blocked) {
          console.warn(`[meso:${agentLabel}] BLOCKED bash: ${event.input.command} — ${result.reason}`);
          return { block: true, reason: `Guardrail: ${result.reason}` };
        }
      }
      if ((event.toolName === "write" || event.toolName === "edit") && event.input?.path) {
        const result = checkFilePath(event.input.path);
        if (result.blocked) {
          console.warn(`[meso:${agentLabel}] BLOCKED ${event.toolName}: ${event.input.path} — ${result.reason}`);
          return { block: true, reason: `Guardrail: ${result.reason}` };
        }
      }
      if (event.toolName === "read" && event.input?.path) {
        const result = checkFilePath(event.input.path);
        if (result.blocked) {
          console.warn(`[meso:${agentLabel}] BLOCKED read: ${event.input.path} — ${result.reason}`);
          return { block: true, reason: `Guardrail: ${result.reason}` };
        }
      }
    });
  };
}

// ─── System prompt ────────────────────────────────────────────────────────────

export type AgentMode = "slack" | "tui" | "scheduled";

export function buildSystemPrompt(cwd: string, opts: { mode: AgentMode; includeToday?: boolean }): string {
  const agentRoot = process.env.MESO_AGENT_ROOT || cwd;
  const identity = fs.readFileSync(resolveAgentPath(agentRoot, process.env.MESO_PROMPT_IDENTITY || "IDENTITY.md"), "utf-8");
  const soul = fs.readFileSync(resolveAgentPath(agentRoot, process.env.MESO_PROMPT_SOUL || "SOUL.md"), "utf-8");
  const extraFiles = (() => {
    try {
      return JSON.parse(process.env.MESO_PROMPT_EXTRA || "[]") as string[];
    } catch {
      return [];
    }
  })();
  const extraSections = extraFiles
    .map((file) => fs.readFileSync(resolveAgentPath(agentRoot, file), "utf-8"))
    .join("\n\n");

  const todaySection = opts.includeToday
    ? (() => {
        const today = loadTodayMemories();
        return today ? `\n\n## Today's Memory Log\n${today}` : "";
      })()
    : "";

  const modeSection =
    opts.mode === "slack"
      ? `- You communicate via Slack\n- Use Slack markdown: *bold*, \`code\`, \`\`\`code blocks\`\`\``
      : opts.mode === "voice"
        ? `- You are in voice conversation mode — the user is speaking to you\n- Keep responses short and conversational (1-3 sentences)\n- Avoid code blocks, markdown, or long lists — these don't work in speech\n- Be natural and concise, like a phone call\n- If the user needs detailed output, suggest switching to TUI or Slack`
      : opts.mode === "scheduled"
        ? `- You were triggered automatically by the scheduler\n- Complete the task autonomously\n- If the prompt tells you to send a result somewhere, use the appropriate channel tool\n- Do not assume a human is waiting interactively\n- If the prompt contains explicit delivery instructions, follow them exactly\n- If delivery instructions are vague or missing, prefer asking for clarification when possible during interactive scheduling rather than guessing later`
        : `- You are running in terminal (TUI) mode\n- Use standard markdown for responses`;

  return `${identity}

${soul}

${extraSections ? `${extraSections}\n\n` : ""}## Tools & Context
${modeSection}
- Available tools: read, write, edit, bash, memory${process.env.TAVILY_API_KEY ? ", web_search" : ""}, schedule_job, list_jobs, pause_job, resume_job, remove_job, trigger_event, list_events, remove_event${process.env.MESO_HAS_SLACK_TOOLS === "1" ? ", slack_post_message" : ""}
- When creating scheduled jobs, always save a self-contained prompt. If the user says "here", "this channel", or "this thread", convert that into explicit delivery instructions using the current provider context block in the conversation (for example, <slack_context> today, and similar provider blocks for future channels).
- Scheduled jobs must not depend on hidden runtime context. Everything needed to execute the job later must be written into the saved job prompt.
- Good scheduled job prompts explicitly answer: what to do, what sources/tools to use, how to format the result, and where to send it.
- Prefer writing prompts like: "Gather X, summarize as Y, then send it using tool Z to destination Q." rather than vague prompts like "send the update here later".
- For recurring jobs, optimize for repeatability and low ambiguity.
- Memory system: the active agent memory directory contains MEMORY.md as the permanent index and daily logs in memory-YYYY-MM-DD.md. Proactively save important information. When something is worth long-term remembering, also update the index with memory update_index.
- When the user references something from a past conversation, use memory search.${todaySection}`;
}
