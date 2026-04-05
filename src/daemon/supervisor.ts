#!/usr/bin/env node
/**
 * Meso Agent Supervisor
 *
 * Lightweight detached process that manages an agent's child processes
 * (channel bot + scheduler). Handles restart, log rotation, memory limits.
 *
 * Spawned by daemon.ts, receives config via argv:
 *   node supervisor.js <configJson>
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

// ─── Config ────────────────────────────────────────────────────────────────────

interface ChildConfig {
  name: string;
  script: string;
  args: string[];
  maxMemoryMB?: number;
}

interface SupervisorConfig {
  agentId: string;
  agentRoot: string;
  logsDir: string;
  stateFile: string;
  cwd: string;
  env: Record<string, string>;
  children: ChildConfig[];
}

const configJson = process.argv[2];
if (!configJson) {
  console.error("supervisor: missing config argument");
  process.exit(1);
}

const config: SupervisorConfig = JSON.parse(configJson);

// ─── Constants ─────────────────────────────────────────────────────────────────

const RESTART_DELAY_BASE = 3_000;
const RESTART_DELAY_MAX = 60_000;
const RESTART_BACKOFF = 1.5;
const MAX_RESTARTS = 50;
const RESTART_WINDOW = 3_600_000; // 1 hour — reset counter after quiet period
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const LOG_RETAIN = 7;
const LOG_CHECK_INTERVAL = 60_000;
const MEMORY_CHECK_INTERVAL = 30_000;
const KILL_TIMEOUT = 5_000;

// ─── State ─────────────────────────────────────────────────────────────────────

interface ChildState {
  config: ChildConfig;
  process: ChildProcess | null;
  pid: number;
  restartCount: number;
  lastRestartAt: number;
  firstRestartAt: number;
  status: "running" | "stopped" | "errored";
  outPath: string;
  errPath: string;
  outStream: fs.WriteStream | null;
  errStream: fs.WriteStream | null;
}

const children: ChildState[] = [];
let shuttingDown = false;

// ─── Logging ───────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg: string): void {
  const line = `${ts()} ${msg}\n`;
  process.stdout.write(line);
}

function openLogStream(filePath: string): fs.WriteStream {
  return fs.createWriteStream(filePath, { flags: "a" });
}

function pipeWithTimestamp(readable: NodeJS.ReadableStream, stream: fs.WriteStream): void {
  let partial = "";
  readable.on("data", (chunk: Buffer) => {
    const text = partial + chunk.toString();
    const lines = text.split("\n");
    partial = lines.pop() || "";
    for (const line of lines) {
      if (line) stream.write(`${ts()} ${line}\n`);
    }
  });
  readable.on("end", () => {
    if (partial) stream.write(`${ts()} ${partial}\n`);
    partial = "";
  });
}

// ─── Log Rotation ──────────────────────────────────────────────────────────────

async function rotateLog(filePath: string): Promise<void> {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < LOG_MAX_BYTES) return;
  } catch {
    return;
  }

  // Shift existing rotated files
  for (let i = LOG_RETAIN; i >= 1; i--) {
    const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const to = `${filePath}.${i}`;
    try {
      if (i === LOG_RETAIN) {
        fs.unlinkSync(`${filePath}.${LOG_RETAIN}`);
        try { fs.unlinkSync(`${filePath}.${LOG_RETAIN}.gz`); } catch {}
      }
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {}
  }

  // Gzip .2 and above in background
  for (let i = 2; i <= LOG_RETAIN; i++) {
    const file = `${filePath}.${i}`;
    if (fs.existsSync(file) && !fs.existsSync(`${file}.gz`)) {
      try {
        const src = fs.createReadStream(file);
        const dest = fs.createWriteStream(`${file}.gz`);
        await pipeline(src, createGzip(), dest);
        fs.unlinkSync(file);
      } catch {}
    }
  }
}

async function checkLogRotation(): Promise<void> {
  for (const child of children) {
    const needsOutRotation = needsRotation(child.outPath);
    const needsErrRotation = needsRotation(child.errPath);

    if (needsOutRotation) {
      child.outStream?.end();
      await rotateLog(child.outPath);
      child.outStream = openLogStream(child.outPath);
      // Re-pipe if child is running
      if (child.process?.stdout) pipeWithTimestamp(child.process.stdout, child.outStream);
    }
    if (needsErrRotation) {
      child.errStream?.end();
      await rotateLog(child.errPath);
      child.errStream = openLogStream(child.errPath);
      if (child.process?.stderr) pipeWithTimestamp(child.process.stderr, child.errStream);
    }
  }
}

function needsRotation(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size >= LOG_MAX_BYTES;
  } catch {
    return false;
  }
}

// ─── Memory Monitor ────────────────────────────────────────────────────────────

function checkMemory(): void {
  for (const child of children) {
    if (!child.config.maxMemoryMB || !child.process || child.status !== "running") continue;
    const pid = child.process.pid;
    if (!pid) continue;
    try {
      const rssKB = parseInt(
        require("node:child_process").execSync(`ps -o rss= -p ${pid}`, { encoding: "utf-8" }).trim(),
        10,
      );
      const rssMB = rssKB / 1024;
      if (rssMB > child.config.maxMemoryMB) {
        log(`[${child.config.name}] Memory ${Math.round(rssMB)}MB exceeds limit ${child.config.maxMemoryMB}MB, restarting`);
        child.process.kill("SIGTERM");
      }
    } catch {}
  }
}

// ─── Daemon State File ─────────────────────────────────────────────────────────

function updateStateFile(): void {
  try {
    let state: any = {};
    try {
      state = JSON.parse(fs.readFileSync(config.stateFile, "utf-8"));
    } catch {}

    if (!state.agents) state.agents = {};
    state.agents[config.agentId] = {
      supervisorPid: process.pid,
      startedAt: startedAt,
      children: Object.fromEntries(
        children.map((c) => [
          c.config.name.replace(`meso-${config.agentId}`, "").replace(/^-/, "") || "channel",
          {
            pid: c.pid,
            name: c.config.name,
            restartCount: c.restartCount,
            status: c.status,
            startedAt: c.lastRestartAt ? new Date(c.lastRestartAt).toISOString() : startedAt,
          },
        ]),
      ),
    };

    const tmp = config.stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, config.stateFile);
  } catch {}
}

const startedAt = new Date().toISOString();

// ─── Child Process Management ──────────────────────────────────────────────────

function getRestartDelay(restartCount: number): number {
  return Math.min(RESTART_DELAY_BASE * Math.pow(RESTART_BACKOFF, restartCount), RESTART_DELAY_MAX);
}

function spawnChild(state: ChildState): void {
  if (shuttingDown) return;

  state.outStream = openLogStream(state.outPath);
  state.errStream = openLogStream(state.errPath);

  const child = spawn("node", [state.config.script, ...state.config.args], {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.process = child;
  state.pid = child.pid || 0;
  state.status = "running";

  if (child.stdout) pipeWithTimestamp(child.stdout, state.outStream!);
  if (child.stderr) pipeWithTimestamp(child.stderr, state.errStream!);

  log(`[${state.config.name}] Started pid=${state.pid}`);
  updateStateFile();

  child.on("exit", (code, signal) => {
    state.status = "stopped";
    state.outStream?.end();
    state.errStream?.end();
    log(`[${state.config.name}] Exited code=${code} signal=${signal}`);

    if (shuttingDown) {
      updateStateFile();
      return;
    }

    // Reset restart count if stable for RESTART_WINDOW
    const now = Date.now();
    if (state.firstRestartAt && now - state.firstRestartAt > RESTART_WINDOW) {
      state.restartCount = 0;
      state.firstRestartAt = 0;
    }

    if (state.restartCount >= MAX_RESTARTS) {
      log(`[${state.config.name}] Max restarts (${MAX_RESTARTS}) reached, giving up`);
      state.status = "errored";
      updateStateFile();
      return;
    }

    state.restartCount++;
    if (!state.firstRestartAt) state.firstRestartAt = now;
    state.lastRestartAt = now;

    const delay = getRestartDelay(state.restartCount - 1);
    log(`[${state.config.name}] Restarting in ${delay}ms (attempt ${state.restartCount}/${MAX_RESTARTS})`);
    updateStateFile();

    setTimeout(() => spawnChild(state), delay);
  });
}

// ─── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Supervisor received ${signal}, shutting down...`);

  const alive = children.filter((c) => c.process && c.status === "running");
  for (const child of alive) {
    try { child.process!.kill("SIGTERM"); } catch {}
  }

  const killTimer = setTimeout(() => {
    for (const child of alive) {
      try { child.process!.kill("SIGKILL"); } catch {}
    }
    cleanup();
  }, KILL_TIMEOUT);

  let exited = 0;
  for (const child of alive) {
    child.process!.on("exit", () => {
      exited++;
      if (exited >= alive.length) {
        clearTimeout(killTimer);
        cleanup();
      }
    });
  }

  if (alive.length === 0) {
    clearTimeout(killTimer);
    cleanup();
  }
}

function cleanup(): void {
  // Remove this agent from state file
  try {
    const state = JSON.parse(fs.readFileSync(config.stateFile, "utf-8"));
    delete state.agents?.[config.agentId];
    const tmp = config.stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, config.stateFile);
  } catch {}

  log("Supervisor exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Main ──────────────────────────────────────────────────────────────────────

fs.mkdirSync(config.logsDir, { recursive: true });

for (const childConfig of config.children) {
  const role = childConfig.name.replace(`meso-${config.agentId}`, "").replace(/^-/, "") || "channel";
  const state: ChildState = {
    config: childConfig,
    process: null,
    pid: 0,
    restartCount: 0,
    lastRestartAt: 0,
    firstRestartAt: 0,
    status: "stopped",
    outPath: path.join(config.logsDir, `${role}-out.log`),
    errPath: path.join(config.logsDir, `${role}-err.log`),
    outStream: null,
    errStream: null,
  };
  children.push(state);
  spawnChild(state);
}

// Periodic checks
setInterval(() => checkLogRotation().catch(() => {}), LOG_CHECK_INTERVAL);
setInterval(checkMemory, MEMORY_CHECK_INTERVAL);

log(`Supervisor started for agent=${config.agentId} pid=${process.pid} children=${children.length}`);
