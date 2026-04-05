import fs from "node:fs";
import path from "node:path";
import {
  applyImportanceDecay,
  logDream,
  getStats,
  getMemoryDir,
} from "../db/memory-db.js";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { loadRuntimeConfig, resolveMainModels } from "../config.js";
import { loadAgent } from "./agent-loader.js";
import { configureAgentEnvironment, loadAgentEnvFile, resolveAgentPath } from "./storage.js";

const KEEP_DAYS = 30;
const MAX_INDEX_LINES = 80;

function readFile(p: string): string {
  try { return fs.readFileSync(p, "utf-8"); } catch { return ""; }
}

function getDailyFiles(memoryDir: string): Array<{ name: string; path: string }> {
  try {
    return fs.readdirSync(memoryDir)
      .filter((f) => /^memory-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .map((name) => ({ name, path: path.join(memoryDir, name) }));
  } catch {
    return [];
  }
}

function deleteOldDailyFiles(memoryDir: string, agentId: string): void {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const f of getDailyFiles(memoryDir)) {
    const mtime = fs.statSync(f.path).mtimeMs;
    if (mtime < cutoff) {
      fs.unlinkSync(f.path);
      console.log(`[scheduler:${agentId}] deleted old daily file: ${f.name}`);
    }
  }
}

function buildPrompt(agentName: string, currentIndex: string, dailyFiles: Array<{ name: string; content: string }>): string {
  const dailySection = dailyFiles.length === 0
    ? "(no daily memory files found)"
    : dailyFiles.map((f) => `### ${f.name}\n${f.content.trim() || "(empty)"}`).join("\n\n");

  return `You are ${agentName}'s memory consolidation process. Your job is to distil recent daily logs into a tight, curated MEMORY.md index.

## Current MEMORY.md
${currentIndex.trim() || "(empty - no index yet)"}

## Daily memory logs (newest first)
${dailySection}

---

## Your task

Produce a new MEMORY.md that will be frozen into the agent system prompt at the start of every session. Every byte costs money on every API call forever - keep it tight.

**Rules:**
- Max ${MAX_INDEX_LINES} lines, aim under 60
- Only include facts with clear long-term value: preferences, recurring patterns, important project context, key people, significant decisions
- **Fade**: ephemeral details, one-off events, time-sensitive info, anything already stale or superseded
- **Merge**: reinforce existing entries rather than duplicating them
- **📌 PINNED entries are non-negotiable** - entries marked with 📌 mean the user explicitly asked the agent to remember them. They MUST always appear in MEMORY.md verbatim.
- **Nothing worth keeping?** Return (empty)
- Use concise markdown: ## Preferences, ## Projects, ## People, ## Decisions - bullet points only
- No timestamps, no "as of today"

Return ONLY the new MEMORY.md content between the markers below, nothing else:

<MEMORY>
(new MEMORY.md content, or the word empty)
</MEMORY>`;
}

function loadModel(modelRegistry: ModelRegistry): Model {
  const config = loadRuntimeConfig();
  return resolveMainModels(config, modelRegistry)[0];
}

async function runConsolidation(agentName: string, settingsFile: string, prompt: string): Promise<string> {
  const cwd = process.cwd();
  const { createAuthStorage, createModelRegistry } = await import("../config.js");
  const authStorage = createAuthStorage();
  const modelRegistry = createModelRegistry(authStorage);
  const model = loadModel(modelRegistry);
  const loader = new DefaultResourceLoader({
    cwd,
    systemPromptOverride: () => `You are ${agentName}'s nightly memory consolidation process. Follow the instructions exactly. Return only what is asked for.`,
  });
  await loader.reload();
  const settingsManager = SettingsManager.create(cwd, path.dirname(settingsFile));
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    model,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    customTools: [],
  });

  let response = "";
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      response += event.assistantMessageEvent.delta;
    }
  });
  await session.prompt(prompt);
  unsubscribe();
  return response;
}

function extractMemoryContent(response: string): string | null {
  const match = response.match(/<MEMORY>([\s\S]*?)<\/MEMORY>/);
  if (!match) return null;
  const content = match[1].trim();
  if (content === "(empty)" || content === "empty") return "";
  return content;
}

export async function runDreamJob(agentId: string): Promise<boolean> {
  loadAgentEnvFile(agentId);
  const agent = loadAgent(agentId);
  configureAgentEnvironment(agentId, agent.paths, agent.configPath);
  process.env.MESO_GUARDRAILS_PROJECT_CONFIG = resolveAgentPath(agent.root, agent.config.guardrails?.projectConfig || "__RUNTIME__/guardrails.json");
  process.env.MESO_GUARDRAILS_LOCAL_CONFIG = resolveAgentPath(agent.root, agent.config.guardrails?.localConfig || "guardrails.local.json");

  const memoryDir = getMemoryDir();
  const memoryIndex = path.join(memoryDir, "MEMORY.md");
  const dailyFiles = getDailyFiles(memoryDir).map((f) => ({ name: f.name, content: readFile(f.path) }));
  if (dailyFiles.length === 0) {
    console.log(`[scheduler:${agentId}] dream: no daily files found, skipping`);
    return false;
  }

  const currentIndex = readFile(memoryIndex);
  const response = await runConsolidation(agent.config.name, agent.paths.settingsFile, buildPrompt(agent.config.name, currentIndex, dailyFiles));
  const newContent = extractMemoryContent(response);
  if (newContent === null) {
    throw new Error("failed to parse dream consolidation response");
  }
  if (newContent !== "") {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryIndex, newContent + "\n");
    console.log(`[scheduler:${agentId}] dream: MEMORY.md updated`);
  }

  const { processed, faded } = applyImportanceDecay(1);
  const stats = getStats();
  logDream(dailyFiles.length, faded, `active=${stats.active} faded=${stats.faded} avgImp=${stats.avgImportance}`);
  console.log(`[scheduler:${agentId}] dream: importance decay ${processed} processed, ${faded} faded`);
  deleteOldDailyFiles(memoryDir, agentId);
  return true;
}
