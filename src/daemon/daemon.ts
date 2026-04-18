/**
 * Meso Daemon — CLI-facing process management API
 *
 * Manages agent supervisor processes. Each agent gets one detached supervisor
 * that watches its children (channel bot + scheduler).
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent, listAgents } from "../core/agent-loader.js";
import { getAgentRoot } from "../core/storage.js";

// ─── Paths ─────────────────────────────────────────────────────────────────────

const MESO_HOME = path.join(os.homedir(), ".meso");
const STATE_FILE = path.join(MESO_HOME, "daemon.json");

function getRepoRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..");
}

function getSupervisorScript(): string {
  return path.join(getRepoRoot(), "daemon", "supervisor.js");
}

function getCliScript(): string {
  return path.join(getRepoRoot(), "cli", "main.js");
}

function getSchedulerScript(): string {
  return path.join(getRepoRoot(), "scheduler.js");
}

// ─── State File ────────────────────────────────────────────────────────────────

interface ChildRecord {
  pid: number;
  name: string;
  restartCount: number;
  status: string;
  startedAt: string;
}

interface AgentEntry {
  supervisorPid: number;
  startedAt: string;
  children: Record<string, ChildRecord>;
}

interface DaemonState {
  agents: Record<string, AgentEntry>;
}

function readState(): DaemonState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { agents: {} };
  }
}

function writeState(state: DaemonState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cleanStaleEntries(): void {
  const state = readState();
  let changed = false;
  for (const [agentId, entry] of Object.entries(state.agents)) {
    if (!isProcessAlive(entry.supervisorPid)) {
      delete state.agents[agentId];
      changed = true;
    }
  }
  if (changed) writeState(state);
}

// ─── Process RSS ───────────────────────────────────────────────────────────────

function getProcessMemoryMB(pid: number): number | null {
  try {
    const rssKB = parseInt(
      execSync(`ps -o rss= -p ${pid}`, { encoding: "utf-8" }).trim(),
      10,
    );
    return Math.round(rssKB / 1024);
  } catch {
    return null;
  }
}

// ─── Start / Stop / Restart ────────────────────────────────────────────────────

export function startAgent(agentId: string): void {
  cleanStaleEntries();

  const state = readState();
  if (state.agents[agentId] && isProcessAlive(state.agents[agentId].supervisorPid)) {
    console.log(`Agent ${agentId} is already running (supervisor pid=${state.agents[agentId].supervisorPid})`);
    return;
  }

  const agent = loadAgent(agentId);
  const logsDir = agent.paths.logsDir;

  const supervisorConfig = {
    agentId,
    agentRoot: agent.paths.root,
    logsDir,
    stateFile: STATE_FILE,
    cwd: agent.paths.root,
    env: {
      NODE_ENV: "production",
      MESO_AGENT_ID: agentId,
      MESO_DEFAULT_AGENT: agentId,
    },
    children: [
      {
        name: `meso-${agentId}`,
        script: getCliScript(),
        args: ["run", agentId, "--channel"],
        maxMemoryMB: 512,
      },
      {
        name: `meso-${agentId}-scheduler`,
        script: getSchedulerScript(),
        args: [],
      },
    ],
  };

  fs.mkdirSync(logsDir, { recursive: true });

  const supervisorLogPath = path.join(logsDir, "supervisor.log");
  const supervisorLog = fs.openSync(supervisorLogPath, "a");

  const child = spawn("node", [getSupervisorScript(), JSON.stringify(supervisorConfig)], {
    cwd: agent.paths.root,
    env: { ...process.env, ...supervisorConfig.env },
    detached: true,
    stdio: ["ignore", supervisorLog, supervisorLog],
  });

  child.unref();
  fs.closeSync(supervisorLog);

  console.log(`Started agent ${agentId} (supervisor pid=${child.pid})`);
}

export function stopAgent(agentId: string): void {
  cleanStaleEntries();

  const state = readState();
  const entry = state.agents[agentId];
  if (!entry) {
    console.log(`Agent ${agentId} is not running`);
    return;
  }

  const pid = entry.supervisorPid;
  if (!isProcessAlive(pid)) {
    delete state.agents[agentId];
    writeState(state);
    console.log(`Agent ${agentId} was not running (stale state cleaned)`);
    return;
  }

  // Send SIGTERM to supervisor (it propagates to children)
  try {
    process.kill(pid, "SIGTERM");
  } catch {}

  // Wait up to 5s for clean exit
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    execSync("sleep 0.1");
  }

  // Force kill if still alive
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    // Also kill any children that might be orphaned
    for (const child of Object.values(entry.children)) {
      if (child.pid && isProcessAlive(child.pid)) {
        try { process.kill(child.pid, "SIGKILL"); } catch {}
      }
    }
  }

  // Clean state
  delete state.agents[agentId];
  writeState(state);

  console.log(`Stopped agent ${agentId}`);
}

export function restartAgent(agentId: string): void {
  stopAgent(agentId);
  startAgent(agentId);
}

// ─── Status ────────────────────────────────────────────────────────────────────

export interface AgentStatus {
  agentId: string;
  name: string;
  pid: number;
  status: string;
  uptime: string;
  restarts: number;
  memory: string;
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function getStatus(): AgentStatus[] {
  cleanStaleEntries();

  const state = readState();
  const results: AgentStatus[] = [];

  for (const [agentId, entry] of Object.entries(state.agents)) {
    const supervisorAlive = isProcessAlive(entry.supervisorPid);

    for (const [, child] of Object.entries(entry.children)) {
      const alive = child.pid > 0 && isProcessAlive(child.pid);
      const mem = alive ? getProcessMemoryMB(child.pid) : null;
      results.push({
        agentId,
        name: child.name,
        pid: child.pid,
        status: !supervisorAlive ? "dead" : alive ? "online" : child.status || "stopped",
        uptime: alive ? formatUptime(child.startedAt) : "-",
        restarts: child.restartCount,
        memory: mem !== null ? `${mem} MB` : "-",
      });
    }
  }

  return results;
}

export function printStatus(): void {
  const rows = getStatus();
  if (rows.length === 0) {
    console.log("No agents running");
    return;
  }

  const header = { agentId: "Agent", name: "Process", pid: "PID", status: "Status", uptime: "Uptime", restarts: "Restarts", memory: "Memory" };
  const allRows = [header, ...rows.map((r) => ({ ...r, pid: String(r.pid), restarts: String(r.restarts) }))];

  const cols = Object.keys(header) as (keyof typeof header)[];
  const widths: Record<string, number> = {};
  for (const col of cols) {
    widths[col] = Math.max(...allRows.map((r) => String((r as any)[col]).length));
  }

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const line = cols.map((col) => String((row as any)[col]).padEnd(widths[col] + 2)).join("");
    console.log(line);
    if (i === 0) console.log(cols.map((col) => "─".repeat(widths[col] + 2)).join(""));
  }
}

// ─── Start All ─────────────────────────────────────────────────────────────────

export function startAll(): void {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log("No agents found. Create one with: meso new <agent>");
    return;
  }
  for (const agentId of agents) {
    try {
      const agent = loadAgent(agentId);
      if (agent.config.runners?.slack?.enabled || agent.config.runners?.tui?.enabled) {
        startAgent(agentId);
      }
    } catch (err) {
      console.error(`Failed to start ${agentId}:`, err instanceof Error ? err.message : err);
    }
  }
}

export function stopAll(): void {
  const state = readState();
  for (const agentId of Object.keys(state.agents)) {
    stopAgent(agentId);
  }
}

export function restartAll(): void {
  const state = readState();
  const agents = Object.keys(state.agents);
  for (const agentId of agents) {
    restartAgent(agentId);
  }
}
