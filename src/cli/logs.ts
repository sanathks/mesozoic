import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadAgent } from "../core/agent-loader.js";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function colorForFile(name: string): string {
  if (name.includes("err")) return COLORS.red;
  if (name.includes("supervisor")) return COLORS.yellow;
  if (name.includes("scheduler")) return COLORS.cyan;
  if (name.includes("channel") || name.includes("slack")) return COLORS.green;
  return COLORS.blue;
}

function labelForFile(name: string): string {
  if (name.includes("channel-out") || name.includes("slack-out")) return "agent";
  if (name.includes("channel-err") || name.includes("slack-err")) return "error";
  if (name.includes("scheduler-out")) return "sched";
  if (name.includes("scheduler-err")) return "sched:err";
  if (name.includes("supervisor")) return "supervisor";
  return name.replace(/\.log$/, "");
}

function getActiveLogFiles(logsDir: string): string[] {
  if (!fs.existsSync(logsDir)) return [];
  return fs.readdirSync(logsDir)
    .filter((f) => f.endsWith(".log") && !f.includes("__") && !f.includes(".json"))
    .map((f) => path.join(logsDir, f))
    .sort();
}

export function runAgentLogs(agentId: string, follow = false): void {
  const agent = loadAgent(agentId);
  const files = getActiveLogFiles(agent.paths.logsDir);

  if (files.length === 0) {
    console.log(`No log files found for ${agentId} in ${agent.paths.logsDir}`);
    return;
  }

  if (!follow) {
    // Show last 30 lines from channel-out (main log)
    const mainLog = files.find((f) => f.includes("channel-out") || f.includes("slack-out"));
    if (mainLog) {
      const lines = fs.readFileSync(mainLog, "utf-8").trim().split("\n");
      const recent = lines.slice(-30);
      for (const line of recent) {
        console.log(line);
      }
    } else {
      console.log("Log files:");
      for (const f of files) console.log(`  ${f}`);
    }
    return;
  }

  // Follow mode: tail all active logs with colored labels
  const child = spawn("tail", ["-f", "-n", "20", ...files], { stdio: ["ignore", "pipe", "pipe"] });

  const labels = new Map<string, { color: string; label: string }>();
  for (const f of files) {
    const name = path.basename(f);
    labels.set(f, { color: colorForFile(name), label: labelForFile(name) });
  }

  let currentFile = "";

  function processLine(line: string): void {
    // tail -f outputs "==> filename <==" headers when switching files
    const headerMatch = line.match(/^==> (.+) <==$/);
    if (headerMatch) {
      currentFile = headerMatch[1];
      return;
    }

    if (!line.trim()) return;

    const meta = labels.get(currentFile);
    if (meta) {
      const padded = meta.label.padEnd(10);
      console.log(`${meta.color}${padded}${COLORS.reset} ${line}`);
    } else {
      console.log(line);
    }
  }

  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  child.on("exit", (code) => process.exit(code ?? 0));

  // Clean exit on Ctrl+C
  process.on("SIGINT", () => {
    child.kill();
    process.exit(0);
  });
}
