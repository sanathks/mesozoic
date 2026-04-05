import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getModel, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry as MR } from "@mariozechner/pi-coding-agent";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, AgentModelRef } from "./types/agent.js";

export interface RuntimeConfig {
  models: AgentModelRef[];
  sideModel: AgentModelRef;
}

export interface SideModelEndpoint {
  baseUrl: string;
  modelId: string;
  provider: string;
  apiKey: string;
}

export const MESO_DIR = path.join(os.homedir(), ".meso");
export const MESO_AUTH_FILE = path.join(MESO_DIR, "auth.json");
export const MESO_MODELS_FILE = path.join(MESO_DIR, "models.json");
export const MESO_RUNTIME_DIR = path.join(MESO_DIR, "runtime");
export const MESO_SESSIONS_DIR = path.join(MESO_RUNTIME_DIR, "sessions");
export const MESO_LOGS_DIR = path.join(MESO_RUNTIME_DIR, "logs");

export function ensureRuntimeDirs(): void {
  fs.mkdirSync(MESO_SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(MESO_LOGS_DIR, { recursive: true });
}

/**
 * Create AuthStorage using meso's own path (~/.meso/auth.json).
 * Falls back to Pi's default (~/.pi/agent/auth.json) if meso's doesn't exist
 * but Pi's does — enables migration from Pi-only setups.
 */
export function createAuthStorage(): InstanceType<typeof AuthStorage> {
  if (fs.existsSync(MESO_AUTH_FILE)) {
    return AuthStorage.create(MESO_AUTH_FILE);
  }
  // Migrate: if Pi auth exists but meso's doesn't, copy it
  const piAuthFile = path.join(os.homedir(), ".pi", "agent", "auth.json");
  if (fs.existsSync(piAuthFile)) {
    fs.mkdirSync(MESO_DIR, { recursive: true });
    fs.copyFileSync(piAuthFile, MESO_AUTH_FILE);
    return AuthStorage.create(MESO_AUTH_FILE);
  }
  fs.mkdirSync(MESO_DIR, { recursive: true });
  return AuthStorage.create(MESO_AUTH_FILE);
}

export function createModelRegistry(authStorage?: InstanceType<typeof AuthStorage>): ModelRegistry {
  const auth = authStorage || createAuthStorage();
  return MR.create(auth, fs.existsSync(MESO_MODELS_FILE) ? MESO_MODELS_FILE : undefined);
}

const BUILTIN_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  "openai-codex": "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

const MODELS_PATH = MESO_MODELS_FILE;

function getProviderBaseUrl(provider: string): string {
  try {
    const piModels = JSON.parse(fs.readFileSync(MODELS_PATH, "utf-8"));
    const url = piModels?.providers?.[provider]?.baseUrl;
    if (url) return url;
  } catch {}

  const builtin = BUILTIN_BASE_URLS[provider];
  if (builtin) return builtin;
  throw new Error(`[config] Unknown provider \"${provider}\"`);
}

function getProviderApiKey(provider: string): string {
  try {
    const piModels = JSON.parse(fs.readFileSync(MODELS_PATH, "utf-8"));
    const key = piModels?.providers?.[provider]?.apiKey;
    if (key) return key;
  } catch {}

  const envMap: Record<string, string> = {
    anthropic: process.env.ANTHROPIC_API_KEY ?? "",
    openai: process.env.OPENAI_API_KEY ?? "",
    "openai-codex": process.env.OPENAI_API_KEY ?? "",
    ollama: "ollama",
  };
  return envMap[provider] ?? "";
}

function agentToRuntimeConfig(agent: AgentConfig): RuntimeConfig {
  return {
    models: agent.models.main,
    sideModel: agent.models.side,
  };
}

export function loadRuntimeConfig(): RuntimeConfig {
  const agentConfigPath = process.env.MESO_AGENT_CONFIG;
  if (!agentConfigPath || !fs.existsSync(agentConfigPath)) {
    throw new Error("[config] MESO_AGENT_CONFIG is not set - load an agent through the Meso runtime first");
  }
  const agent = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as AgentConfig;
  return agentToRuntimeConfig(agent);
}

export function resolveMainModels(config: RuntimeConfig, modelRegistry: ModelRegistry): Model[] {
  const models: Model[] = [];
  for (const entry of config.models) {
    const model = modelRegistry.find(entry.provider as any, entry.id) ?? getModel(entry.provider as any, entry.id);
    if (model) models.push(model);
    else console.warn(`[config] Model not found: ${entry.provider}/${entry.id}, skipping`);
  }
  if (models.length === 0) throw new Error("[config] No valid models found");
  return models;
}

export function resolveSideModelEndpoint(config: RuntimeConfig): SideModelEndpoint {
  const { provider, id } = config.sideModel;
  return {
    baseUrl: getProviderBaseUrl(provider),
    modelId: id,
    provider,
    apiKey: getProviderApiKey(provider),
  };
}
