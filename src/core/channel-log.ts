import fs from "node:fs";
import path from "node:path";
import type { AgentPaths } from "../types/agent.js";

interface ChannelLogEntry {
  date: string;
  provider: string;
  direction: "incoming" | "outgoing" | "system";
  channelId: string;
  threadId: string;
  userId?: string;
  text: string;
  meta?: Record<string, string | number | boolean | null | undefined>;
}

function sanitizePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getTranscriptPath(paths: AgentPaths, provider: string, channelId: string, threadId: string): string {
  return path.join(paths.logsDir, "channels", sanitizePart(provider), sanitizePart(channelId), `${sanitizePart(threadId)}.jsonl`);
}

export function appendChannelLog(paths: AgentPaths, entry: ChannelLogEntry): void {
  const filePath = getTranscriptPath(paths, entry.provider, entry.channelId, entry.threadId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
}

export function getChannelLogsRoot(paths: AgentPaths): string {
  return path.join(paths.logsDir, "channels");
}
