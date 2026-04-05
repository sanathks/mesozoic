/**
 * Agent config upgrade system.
 *
 * Compares an agent's config against the current template defaults and
 * adds missing fields without overwriting user-defined values.
 *
 * The config version tracks which migrations have been applied.
 * Each migration is a function that receives the config and returns
 * whether it made changes.
 */
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { loadAgent, listAgents } from "../core/agent-loader.js";
import { getAgentRoot } from "../core/storage.js";

// ─── Current schema version ──────────────────────────────────────────────────
// Bump this when adding new migrations.
export const CURRENT_CONFIG_VERSION = 1;

// ─── Deep merge (add missing keys only) ─────────────────────────────────────

function deepMergeDefaults(target: any, defaults: any): { merged: any; additions: string[] } {
  const additions: string[] = [];

  function merge(t: any, d: any, path: string): any {
    if (d === null || d === undefined) return t;
    if (typeof d !== "object" || Array.isArray(d)) return t ?? d;

    const result = t && typeof t === "object" && !Array.isArray(t) ? { ...t } : {};

    for (const key of Object.keys(d)) {
      const fullPath = path ? `${path}.${key}` : key;
      if (!(key in result)) {
        result[key] = d[key];
        additions.push(fullPath);
      } else if (typeof d[key] === "object" && d[key] !== null && !Array.isArray(d[key])) {
        const sub = merge(result[key], d[key], fullPath);
        result[key] = sub;
      }
      // Existing scalar/array values are never overwritten
    }

    return result;
  }

  const merged = merge(target, defaults, "");
  return { merged, additions };
}

// ─── Migrations ──────────────────────────────────────────────────────────────
// Each migration runs if the agent's configVersion is below its target version.

interface Migration {
  version: number;
  description: string;
  apply: (config: any, agentRoot: string) => string[]; // returns list of changes
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial config schema",
    apply: (config, agentRoot) => {
      const changes: string[] = [];

      // Add configVersion
      if (config.configVersion === undefined) {
        config.configVersion = 1;
        changes.push("added configVersion");
      }

      // Behavior defaults
      if (!config.behavior) config.behavior = {};
      if (!("stopWord" in config.behavior)) {
        config.behavior.stopWord = "stop";
        changes.push('behavior.stopWord = "stop"');
      }
      if (!("continuousDmSession" in config.behavior)) {
        config.behavior.continuousDmSession = true;
        changes.push("behavior.continuousDmSession = true");
      }

      // Runtime config (migrate from settings.json if present)
      if (!config.runtime) {
        const settingsPath = path.join(agentRoot, "settings.json");
        let existing: any = {};
        try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}

        config.runtime = {
          thinking: existing.defaultThinkingLevel || "off",
          compaction: {
            enabled: existing.compaction?.enabled ?? true,
            reserveTokens: existing.compaction?.reserveTokens ?? 16384,
            keepRecentTokens: existing.compaction?.keepRecentTokens ?? 20000,
          },
          retry: {
            enabled: existing.retry?.enabled ?? true,
            maxRetries: existing.retry?.maxRetries ?? 3,
            baseDelayMs: existing.retry?.baseDelayMs ?? 2000,
            maxDelayMs: existing.retry?.maxDelayMs ?? 60000,
          },
        };
        changes.push("added runtime config");
      }

      // Move system files into .runtime/
      const rtDir = path.join(agentRoot, ".runtime");
      fs.mkdirSync(rtDir, { recursive: true });

      const moves: Array<[string, string]> = [
        ["settings.json", ".runtime/pi-settings.json"],
        ["runtime-state.json", ".runtime/state.json"],
        ["memory.db", ".runtime/memory.db"],
        ["memory.db-shm", ".runtime/memory.db-shm"],
        ["memory.db-wal", ".runtime/memory.db-wal"],
      ];
      for (const [from, to] of moves) {
        const src = path.join(agentRoot, from);
        const dest = path.join(agentRoot, to);
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.renameSync(src, dest);
          changes.push(`moved ${from} → ${to}`);
        }
      }

      // Ensure user-visible dirs
      for (const dir of ["sessions", "logs", "memory", "events", "tools", "skills"]) {
        const dirPath = path.join(agentRoot, dir);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
          changes.push(`created ${dir}/`);
        }
      }

      // Guardrails mode
      const guardrailsPath = path.join(agentRoot, config.guardrails?.localConfig || "guardrails.local.json");
      if (fs.existsSync(guardrailsPath)) {
        try {
          const local = JSON.parse(fs.readFileSync(guardrailsPath, "utf-8"));
          if (!("mode" in local)) {
            local.mode = "standard";
            fs.writeFileSync(guardrailsPath, JSON.stringify(local, null, 2) + "\n");
            changes.push('guardrails mode = "standard"');
          }
        } catch {}
      }

      // Remove storage overrides — defaults handle paths now
      if (config.storage) {
        delete config.storage;
        changes.push("removed storage overrides (using defaults)");
      }

      return changes;
    },
  },
];

// ─── Upgrade Logic ───────────────────────────────────────────────────────────

export interface UpgradeResult {
  agentId: string;
  fromVersion: number;
  toVersion: number;
  changes: string[];
  skipped: boolean;
}

export function upgradeAgent(agentId: string, dryRun = false): UpgradeResult {
  const agentRoot = getAgentRoot(agentId);
  const configPath = path.join(agentRoot, "agent.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const fromVersion = config.configVersion || 0;

  if (fromVersion >= CURRENT_CONFIG_VERSION) {
    return { agentId, fromVersion, toVersion: fromVersion, changes: [], skipped: true };
  }

  const allChanges: string[] = [];

  for (const migration of migrations) {
    if (fromVersion < migration.version) {
      const changes = migration.apply(config, agentRoot);
      allChanges.push(...changes);
    }
  }

  config.configVersion = CURRENT_CONFIG_VERSION;

  if (!dryRun && allChanges.length > 0) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  return {
    agentId,
    fromVersion,
    toVersion: CURRENT_CONFIG_VERSION,
    changes: allChanges,
    skipped: false,
  };
}

export function checkNeedsUpgrade(agentId: string): boolean {
  try {
    const configPath = path.join(getAgentRoot(agentId), "agent.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return (config.configVersion || 0) < CURRENT_CONFIG_VERSION;
  } catch {
    return false;
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export async function runUpgrade(agentId?: string): Promise<void> {
  const agents = agentId ? [agentId] : listAgents();

  if (agents.length === 0) {
    console.log("No agents found.");
    return;
  }

  p.intro("meso upgrade");

  let totalChanges = 0;

  for (const id of agents) {
    const result = upgradeAgent(id, true); // dry run first

    if (result.skipped) {
      p.log.success(`${id}: already up to date (v${result.fromVersion})`);
      continue;
    }

    p.log.info(`${id}: v${result.fromVersion} → v${result.toVersion}`);
    for (const change of result.changes) {
      p.log.message(`  + ${change}`);
    }

    const confirm = await p.confirm({
      message: `Apply ${result.changes.length} changes to ${id}?`,
      initialValue: true,
    });

    if (p.isCancel(confirm) || !confirm) {
      p.log.warn(`Skipped ${id}`);
      continue;
    }

    // Apply for real
    const applied = upgradeAgent(id, false);
    totalChanges += applied.changes.length;
    p.log.success(`${id}: upgraded to v${applied.toVersion}`);
  }

  p.outro(totalChanges > 0 ? `${totalChanges} changes applied` : "No changes needed");
}
