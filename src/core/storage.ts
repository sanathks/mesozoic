import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import type { AgentConfig, AgentPaths } from "../types/agent.js";

export const MESO_HOME = path.join(os.homedir(), ".meso");
export const MESO_AGENTS_DIR = path.join(MESO_HOME, "agents");

export function ensureMesoHome(): void {
  fs.mkdirSync(MESO_HOME, { recursive: true });
  fs.mkdirSync(MESO_AGENTS_DIR, { recursive: true });
}

export function getAgentRoot(agentId: string): string {
  return path.join(MESO_AGENTS_DIR, agentId);
}

export function getCurrentAgentRoot(): string | null {
  return process.env.MESO_AGENT_ROOT || null;
}

export function getCurrentAgentId(): string | null {
  return process.env.MESO_AGENT_ID || null;
}

export function resolveAgentPath(root: string, value: string): string {
  if (value.startsWith("__RUNTIME__/")) {
    return path.join(process.cwd(), value.slice("__RUNTIME__/".length));
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  if (path.isAbsolute(value)) return value;
  return path.join(root, value);
}

export function resolveAgentPaths(root: string, config: AgentConfig): AgentPaths {
  const storage = config.storage || {};
  const rt = path.join(root, ".runtime");
  return {
    root,
    runtimeDir: rt,
    // User-visible directories
    sessionsDir: resolveAgentPath(root, storage.sessionsDir || "sessions"),
    logsDir: resolveAgentPath(root, storage.logsDir || "logs"),
    memoryDir: resolveAgentPath(root, storage.memoryDir || "memory"),
    eventsDir: resolveAgentPath(root, storage.eventsDir || "events"),
    guardrailsLocalConfig: resolveAgentPath(root, storage.guardrailsLocalConfig || "guardrails.local.json"),
    jobsFile: resolveAgentPath(root, storage.jobsFile || "jobs.json"),
    // Memory DB (in memory/ dir, user-visible for backup)
    memoryDb: resolveAgentPath(root, storage.memoryDb || "memory/memory.db"),
    settingsFile: resolveAgentPath(root, storage.settingsFile || ".runtime/pi-settings.json"),
    stateFile: path.join(rt, "state.json"),
    eventStateFile: resolveAgentPath(root, storage.eventStateFile || ".runtime/event-state.json"),
  };
}

export function ensureAgentDirs(paths: AgentPaths): void {
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.memoryDir, { recursive: true });
  fs.mkdirSync(paths.eventsDir, { recursive: true });
}

export function loadAgentEnvFile(agentId: string): string | null {
  const envPath = path.join(getAgentRoot(agentId), ".env");
  if (!fs.existsSync(envPath)) return null;
  dotenv.config({ path: envPath, override: false });
  return envPath;
}

export function configureAgentEnvironment(agentId: string, paths: AgentPaths, configPath: string): void {
  process.env.MESO_AGENT_ID = agentId;
  process.env.MESO_AGENT_ROOT = paths.root;
  process.env.MESO_AGENT_CONFIG = configPath;
  process.env.MESO_SESSIONS_DIR = paths.sessionsDir;
  process.env.MESO_LOGS_DIR = paths.logsDir;
  process.env.MESO_MEMORY_DIR = paths.memoryDir;
  process.env.MESO_MEMORY_DB = paths.memoryDb;
  process.env.MESO_SETTINGS_FILE = paths.settingsFile;
  process.env.MESO_GUARDRAILS_LOCAL_CONFIG = paths.guardrailsLocalConfig;
  process.env.MESO_JOBS_FILE = paths.jobsFile;
  process.env.MESO_EVENTS_DIR = paths.eventsDir;
  process.env.MESO_EVENT_STATE_FILE = paths.eventStateFile;
}
