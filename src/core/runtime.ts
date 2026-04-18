import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { loadAgent, type LoadedAgent } from "./agent-loader.js";
import { configureAgentEnvironment, resolveAgentPath } from "./storage.js";
import { createAuthStorage, createModelRegistry, resolveMainModels, type RuntimeConfig } from "../config.js";
import { buildSystemPrompt } from "../agent-factory.js";
import { scheduleExtraction } from "../extract-memories.js";
import { loadMemoryIndex, loadTodayMemories } from "../tools/memory.js";
import { resolveTools } from "./tool-registry.js";
import { resolveExtensionFactories } from "./extension-registry.js";
import { createSchedulerTools } from "../tools/scheduler.js";
import { createChannelTools } from "../tools/channels/index.js";
import { hasSlackProvider } from "./channel-providers.js";
import { RuntimeState } from "./runtime-state.js";
import { setSelfToolContext } from "../tools/self.js";

export interface AgentPromptOptions {
  onProgress?: (message: string) => void | Promise<void>;
  onModelSwitch?: (from: string, to: string, reason: string) => void | Promise<void>;
}

export interface AgentRuntime {
  agent: LoadedAgent;
  session: AgentSession;
  prompt(text: string, options?: AgentPromptOptions): Promise<string>;
  followUp(text: string): Promise<void>;
  cycleModel(): Promise<string>;
  getCurrentModel(): string;
}

export interface AgentRuntimeOptions {
  extraTools?: any[];
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("overloaded") || msg.includes("capacity");
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("abort") || msg.includes("aborted") || msg.includes("cancelled") || msg.includes("canceled");
}

function toRuntimeConfig(agent: LoadedAgent): RuntimeConfig {
  return {
    models: agent.config.models.main,
    sideModel: agent.config.models.side,
  };
}

function runtimeLog(...args: any[]): void {
  if (process.env.MESO_QUIET !== "1") console.log(...args);
}

function runtimeError(...args: any[]): void {
  if (process.env.MESO_QUIET !== "1") console.error(...args);
}

/**
 * Sync agent.json runtime settings → Pi's settings.json.
 * User edits agent.json, we generate settings.json for Pi.
 */
function syncPiSettings(agent: LoadedAgent): void {
  const rt = agent.config.runtime;
  const settings: Record<string, any> = {
    skills: ["./skills"],
    enableSkillCommands: true,
  };

  settings.defaultThinkingLevel = rt?.thinking ?? "off";

  settings.compaction = {
    enabled: rt?.compaction?.enabled ?? true,
    reserveTokens: rt?.compaction?.reserveTokens ?? 16384,
    keepRecentTokens: rt?.compaction?.keepRecentTokens ?? 20000,
  };

  settings.retry = {
    enabled: rt?.retry?.enabled ?? true,
    maxRetries: rt?.retry?.maxRetries ?? 3,
    baseDelayMs: rt?.retry?.baseDelayMs ?? 2000,
    maxDelayMs: rt?.retry?.maxDelayMs ?? 60000,
  };

  // Write to where Pi expects it
  fs.writeFileSync(agent.paths.settingsFile, JSON.stringify(settings, null, 2) + "\n");
}

export async function createAgentRuntime(agentId: string, sessionId: string, mode: "slack" | "tui" | "voice" | "scheduled", options: AgentRuntimeOptions = {}): Promise<AgentRuntime> {
  const agent = loadAgent(agentId);
  configureAgentEnvironment(agentId, agent.paths, agent.configPath);
  const loaderAgentDir = agent.paths.root;
  process.env.MESO_LOADER_AGENT_DIR = loaderAgentDir;
  process.env.MESO_PROMPT_IDENTITY = agent.config.prompts.identity;
  process.env.MESO_PROMPT_SOUL = agent.config.prompts.soul;
  process.env.MESO_PROMPT_EXTRA = JSON.stringify(agent.config.prompts.extra || []);
  process.env.MESO_GUARDRAILS_PROJECT_CONFIG = resolveAgentPath(agent.root, agent.config.guardrails?.projectConfig || "__RUNTIME__/guardrails.json");
  process.env.MESO_GUARDRAILS_LOCAL_CONFIG = resolveAgentPath(agent.root, agent.config.guardrails?.localConfig || "guardrails.local.json");

  process.env.MESO_HAS_SLACK_TOOLS = hasSlackProvider(agent) ? "1" : "0";

  // Sync Pi's settings.json from agent.json runtime config
  syncPiSettings(agent);

  const authStorage = createAuthStorage();
  const modelRegistry = createModelRegistry(authStorage);
  const models = resolveMainModels(toRuntimeConfig(agent), modelRegistry);
  const cwd = agent.paths.root;
  const systemPrompt = buildSystemPrompt(cwd, { mode, includeToday: mode === "tui" });

  const agentToolsDir = path.join(agent.paths.root, "tools");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: loaderAgentDir,
    additionalExtensionPaths: [agentToolsDir],
    extensionFactories: resolveExtensionFactories(agent.config.extensions?.enabled || []),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const settingsManager = SettingsManager.create(cwd, path.dirname(agent.paths.settingsFile));
  const sessionManager = SessionManager.open(path.join(agent.paths.sessionsDir, `${sessionId}.jsonl`), agent.paths.sessionsDir);

  const { session } = await createAgentSession({
    cwd,
    model: models[0],
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    customTools: [
      ...resolveTools(agent.config.tools?.enabled || []),
      ...createSchedulerTools(agentId),
      ...createChannelTools(agentId),
      ...(options.extraTools || []),
    ],
  });

  let todayMemoriesInjected = false;
  let memorySavedThisTurn = false;
  const PRIMARY_COOLDOWN_MS = 60 * 60_000; // 1 hour

  // ─── Persisted runtime state ─────────────────────────────────────────────────
  const runtimeState = new RuntimeState(agent.paths.stateFile);

  const savedModel = runtimeState.get("model");
  let currentModelIndex = savedModel.currentIndex >= 0 && savedModel.currentIndex < models.length
    ? savedModel.currentIndex : 0;
  let primaryCooldownUntil = savedModel.primaryCooldownUntil;

  // Apply persisted model on startup
  if (currentModelIndex !== 0) {
    const startupModel = models[currentModelIndex];
    runtimeLog(`[meso:${agent.config.name}] Resuming with model: ${startupModel.provider}/${startupModel.id} (cooldown until ${new Date(primaryCooldownUntil).toISOString()})`);
    try {
      await session.setModel(startupModel);
    } catch {
      currentModelIndex = 0;
      primaryCooldownUntil = 0;
      runtimeState.set("model", { currentIndex: 0, primaryCooldownUntil: 0 });
    }
  }

  function persistModelState(): void {
    runtimeState.set("model", { currentIndex: currentModelIndex, primaryCooldownUntil });
  }

  async function switchToNextModel(): Promise<boolean> {
    for (let i = 1; i < models.length; i++) {
      const nextIndex = (currentModelIndex + i) % models.length;
      const nextModel = models[nextIndex];
      try {
        await session.setModel(nextModel);
        const wasIndex = currentModelIndex;
        currentModelIndex = nextIndex;
        if (wasIndex === 0) {
          primaryCooldownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
          runtimeLog(`[meso:${agent.config.name}] Primary model on cooldown until ${new Date(primaryCooldownUntil).toISOString()}`);
        }
        runtimeLog(`[meso:${agent.config.name}] Switched to fallback model: ${nextModel.provider}/${nextModel.id}`);
        persistModelState();
        return true;
      } catch {}
    }
    return false;
  }

  async function tryRestorePrimaryModel(): Promise<void> {
    if (currentModelIndex === 0) return;
    if (Date.now() < primaryCooldownUntil) return;
    try {
      await session.setModel(models[0]);
      currentModelIndex = 0;
      primaryCooldownUntil = 0;
      persistModelState();
      runtimeLog(`[meso:${agent.config.name}] Restored primary model: ${models[0].provider}/${models[0].id}`);
    } catch {}
  }

  async function manualCycleModel(): Promise<string> {
    const prevIndex = currentModelIndex;
    const nextIndex = (currentModelIndex + 1) % models.length;
    const nextModel = models[nextIndex];
    try {
      await session.setModel(nextModel);
      currentModelIndex = nextIndex;
      primaryCooldownUntil = 0;
      persistModelState();
      runtimeLog(`[meso:${agent.config.name}] Manual model switch: ${nextModel.provider}/${nextModel.id}`);
      return `${nextModel.provider}/${nextModel.id}`;
    } catch {
      return `Failed to switch (staying on ${models[prevIndex].provider}/${models[prevIndex].id})`;
    }
  }

  function getCurrentModel(): string {
    const m = models[currentModelIndex];
    return `${m.provider}/${m.id}`;
  }

  // Wire up the self tool context (after model state is initialized)
  setSelfToolContext({
    agentId,
    agentRoot: agent.paths.root,
    configPath: agent.configPath,
    reloadResources: () => loader.reload(),
    getAvailableModels: async () => {
      try {
        const available = await modelRegistry.getAvailable();
        return available.map((m: any) => ({ provider: m.provider, id: m.id }));
      } catch { return []; }
    },
    getCurrentModel,
    switchModel: async (provider: string, id: string) => {
      const model = modelRegistry.find(provider, id);
      if (!model) return false;
      try {
        await session.setModel(model);
        let idx = models.findIndex((m: any) => m.provider === provider && m.id === id);
        if (idx === -1) { models.push(model); idx = models.length - 1; }
        currentModelIndex = idx;
        primaryCooldownUntil = 0;
        persistModelState();
        return true;
      } catch { return false; }
    },
  });

  async function prompt(text: string, options?: AgentPromptOptions): Promise<string> {
    let userText = text;
    if (!todayMemoriesInjected) {
      todayMemoriesInjected = true;
      const memoryIndex = loadMemoryIndex();
      const todayCtx = loadTodayMemories();
      const memoryBlock = [
        memoryIndex ? `<memory:index>\n${memoryIndex}\n</memory:index>` : "",
        todayCtx ? `<memory:today>\n${todayCtx}\n</memory:today>` : "",
      ].filter(Boolean).join("\n\n");
      if (memoryBlock) {
        userText = `${memoryBlock}\n\n${text}`;
      }
    }

    await tryRestorePrimaryModel();
    let lastError: unknown;

    for (let attempt = 0; attempt < models.length; attempt++) {
      let fullResponse = "";
      memorySavedThisTurn = false;
      let lastProgressAt = 0;
      let lastProgressMessage = "";
      let sentToolProgress = false;
      const longRunTimer = options?.onProgress
        ? setTimeout(() => {
            void emitProgress("Still working on it.");
          }, 12000)
        : undefined;

      const emitProgress = async (message: string) => {
        if (!options?.onProgress) return;
        const now = Date.now();
        if (message === lastProgressMessage) return;
        if (now - lastProgressAt < 4000) return;
        lastProgressAt = now;
        lastProgressMessage = message;
        await options.onProgress(message);
      };

      const unsubscribe = session.subscribe((event: any) => {
        if (event.type === "agent_start") void emitProgress("Working on it.");
        if (event.type === "tool_execution_start" && !sentToolProgress) {
          sentToolProgress = true;
          void emitProgress("Checking a few things.");
        }
        if (event.type === "tool_execution_end" && event.toolName === "memory" && !event.isError) {
          memorySavedThisTurn = true;
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          fullResponse += event.assistantMessageEvent.delta;
        }
      });

      try {
        const activeModel = models[currentModelIndex];
        runtimeLog(`[meso:${agent.config.name}] prompt start session=${sessionId} mode=${mode} model=${activeModel.provider}/${activeModel.id}`);
        await session.prompt(userText);
        unsubscribe();
        if (longRunTimer) clearTimeout(longRunTimer);
        runtimeLog(`[meso:${agent.config.name}] prompt success session=${sessionId} model=${activeModel.provider}/${activeModel.id} chars=${fullResponse.length}`);
        scheduleExtraction(text, fullResponse, sessionId, memorySavedThisTurn);
        return fullResponse;
      } catch (err) {
        unsubscribe();
        if (longRunTimer) clearTimeout(longRunTimer);
        const activeModel = models[currentModelIndex];
        runtimeError(`[meso:${agent.config.name}] prompt error session=${sessionId} model=${activeModel.provider}/${activeModel.id}:`, err instanceof Error ? err.message : err);
        lastError = err;
        if (isAbortError(err)) throw err;
        const failedModel = `${activeModel.provider}/${activeModel.id}`;
        const switched = await switchToNextModel();
        if (!switched) throw err;
        const newModel = models[currentModelIndex];
        const newModelName = `${newModel.provider}/${newModel.id}`;
        const reason = isRateLimitError(err) ? "rate-limit" : "error";
        runtimeLog(
          `[meso:${agent.config.name}] retrying prompt with ${newModelName} after ${reason} on ${failedModel}`,
        );
        if (options?.onModelSwitch) {
          await options.onModelSwitch(failedModel, newModelName, reason);
        }
        continue;
      }
    }

    throw lastError;
  }

  async function followUp(text: string): Promise<void> {
    await session.followUp(text);
  }

  return { agent, session, prompt, followUp, cycleModel: manualCycleModel, getCurrentModel };
}
