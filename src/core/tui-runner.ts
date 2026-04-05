import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createAgentRuntime } from "./runtime.js";
import { loadAgent } from "./agent-loader.js";

function logLine(s = "") {
  process.stdout.write(s + "\n");
}

function listSessions(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
    .map((f) => path.join(dir, f));
}

function watchSession(file: string): () => void {
  let position = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const onChange = () => {
    const stat = fs.statSync(file);
    if (stat.size <= position) return;
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(stat.size - position);
    fs.readSync(fd, buffer, 0, stat.size - position, position);
    fs.closeSync(fd);
    position = stat.size;
    for (const line of buffer.toString("utf-8").split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") continue;
        if (entry.type === "message") {
          const msg = entry.message;
          if (msg.role === "user") logLine(`[watch:user] ${Array.isArray(msg.content) ? msg.content.map((c: any) => c.text || "").join(" ") : msg.content}`);
          if (msg.role === "assistant") logLine(`[watch:assistant] ${(msg.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")}`);
          if (msg.role === "toolResult") logLine(`[watch:${msg.toolName}] ${(msg.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")}`);
        }
      } catch {}
    }
  };
  fs.watchFile(file, { interval: 700 }, onChange);
  return () => fs.unwatchFile(file, onChange);
}

export async function runTuiAgent(agentId: string): Promise<void> {
  const agent = loadAgent(agentId);
  const runtime = await createAgentRuntime(agentId, `tui-${Date.now()}`, "tui");
  let unwatch: (() => void) | null = null;
  let isStreaming = false;

  logLine(`\n🌀 Meso TUI — ${agent.config.name}`);
  logLine(`Agent: ${agentId}`);
  logLine(`Type /help for commands.\n`);

  runtime.session.subscribe((event: any) => {
    if (event.type === "agent_start") {
      isStreaming = true;
      process.stdout.write(`\n${agent.config.name}: `);
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      logLine(`\n[tool:start] ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      logLine(`[tool:end] ${event.toolName}${event.isError ? " (error)" : ""}`);
    }
    if (event.type === "agent_end") {
      isStreaming = false;
      logLine("\n");
      rl.prompt();
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${agent.config.name}> `, terminal: true });
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) return rl.prompt();
    if (input === "/exit" || input === "/quit") process.exit(0);
    if (input === "/help") {
      logLine("/watch          list recent sessions");
      logLine("/watch <n>      watch a session");
      logLine("/unwatch        stop watching");
      logLine("/exit           exit");
      return rl.prompt();
    }
    if (input === "/watch") {
      const sessions = listSessions(agent.paths.sessionsDir);
      sessions.slice(0, 20).forEach((file, i) => logLine(`${i + 1}. ${path.basename(file)}`));
      return rl.prompt();
    }
    if (input.startsWith("/watch ")) {
      const n = Number(input.slice(7).trim());
      const sessions = listSessions(agent.paths.sessionsDir);
      const file = sessions[n - 1];
      if (!file) {
        logLine("Invalid session number.");
        return rl.prompt();
      }
      if (unwatch) unwatch();
      unwatch = watchSession(file);
      logLine(`Watching ${file}`);
      return rl.prompt();
    }
    if (input === "/unwatch") {
      if (unwatch) unwatch();
      unwatch = null;
      logLine("Stopped watching.");
      return rl.prompt();
    }

    try {
      await runtime.prompt(input);
    } catch (err: any) {
      isStreaming = false;
      logLine(`Error: ${err?.message ?? err}`);
      rl.prompt();
    }
  });

  rl.on("SIGINT", async () => {
    if (isStreaming) {
      logLine("\n(aborting...)");
      await runtime.session.abort();
    } else {
      process.exit(0);
    }
  });
}
