import fs from "node:fs";
import path from "node:path";
import type { AgentConfig, AgentPaths } from "../types/agent.js";
import {
  ensureAgentDirs,
  ensureMesoHome,
  getAgentRoot,
  resolveAgentPath,
  resolveAgentPaths,
} from "./storage.js";

export interface LoadedAgent {
  id: string;
  config: AgentConfig;
  root: string;
  configPath: string;
  paths: AgentPaths;
}

function validateAgentConfig(config: any, configPath: string): asserts config is AgentConfig {
  if (!config?.id || !config?.name) {
    throw new Error(`[meso] Invalid agent config at ${configPath}: missing id/name`);
  }
  if (!config?.prompts?.identity || !config?.prompts?.soul) {
    throw new Error(`[meso] Invalid agent config at ${configPath}: prompts.identity/soul required`);
  }
  if (!Array.isArray(config?.models?.main) || config.models.main.length === 0) {
    throw new Error(`[meso] Invalid agent config at ${configPath}: models.main must have at least one model`);
  }
  if (!config?.models?.side?.provider || !config?.models?.side?.id) {
    throw new Error(`[meso] Invalid agent config at ${configPath}: models.side required`);
  }
}

export function loadAgent(agentId: string): LoadedAgent {
  ensureMesoHome();
  const root = getAgentRoot(agentId);
  const configPath = path.join(root, "agent.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`[meso] Agent not found: ${agentId} (${configPath})`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  validateAgentConfig(config, configPath);
  const paths = resolveAgentPaths(root, config);
  ensureAgentDirs(paths);

  for (const file of [config.prompts.identity, config.prompts.soul, ...(config.prompts.extra || [])]) {
    const p = resolveAgentPath(root, file);
    if (!fs.existsSync(p)) {
      throw new Error(`[meso] Missing prompt file for ${agentId}: ${p}`);
    }
  }

  return { id: agentId, config, root, configPath, paths };
}

export function listAgents(): string[] {
  ensureMesoHome();
  return fs
    .readdirSync(path.join(process.env.HOME || "", ".meso", "agents"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
