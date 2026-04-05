import fs from "node:fs";
import path from "node:path";
import type { LoadedAgent } from "./agent-loader.js";
import type { ImmediateEvent } from "../types/job.js";

export interface EventState {
  processed: Record<string, string>;
  errors: Record<string, { lastError: string; lastAt: string }>;
}

export interface LoadedImmediateEvent {
  filePath: string;
  fileName: string;
  event: ImmediateEvent;
}

function isValidImmediateEvent(input: any): input is ImmediateEvent {
  return !!input && input.type === "immediate" && typeof input.id === "string" && typeof input.prompt === "string" && typeof input.createdAt === "string";
}

function sortByCreatedAt(events: LoadedImmediateEvent[]): LoadedImmediateEvent[] {
  return [...events].sort((a, b) => new Date(a.event.createdAt).getTime() - new Date(b.event.createdAt).getTime());
}

export function loadEventState(agent: LoadedAgent): EventState {
  try {
    return JSON.parse(fs.readFileSync(agent.paths.eventStateFile, "utf-8"));
  } catch {
    const empty = { processed: {}, errors: {} };
    saveEventState(agent, empty);
    return empty;
  }
}

export function saveEventState(agent: LoadedAgent, state: EventState): void {
  fs.mkdirSync(path.dirname(agent.paths.eventStateFile), { recursive: true });
  fs.writeFileSync(agent.paths.eventStateFile, JSON.stringify(state, null, 2) + "\n");
}

export function loadImmediateEvents(agent: LoadedAgent): LoadedImmediateEvent[] {
  fs.mkdirSync(agent.paths.eventsDir, { recursive: true });
  const files = fs.readdirSync(agent.paths.eventsDir).filter((file) => file.endsWith(".json"));
  const loaded: LoadedImmediateEvent[] = [];
  for (const file of files) {
    const filePath = path.join(agent.paths.eventsDir, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!isValidImmediateEvent(parsed)) continue;
      loaded.push({ filePath, fileName: file, event: parsed });
    } catch {
      continue;
    }
  }
  return sortByCreatedAt(loaded);
}

export function writeImmediateEvent(agent: LoadedAgent, event: ImmediateEvent): string {
  fs.mkdirSync(agent.paths.eventsDir, { recursive: true });
  const safeId = event.id.replace(/[^a-zA-Z0-9._-]/g, "-");
  const timestamp = event.createdAt.replace(/[:.]/g, "-");
  const filePath = path.join(agent.paths.eventsDir, `${timestamp}-${safeId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(event, null, 2) + "\n");
  return filePath;
}

export function removeImmediateEvent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}
