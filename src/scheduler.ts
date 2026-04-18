import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadAgent } from "./core/agent-loader.js";
import { configureAgentEnvironment, loadAgentEnvFile } from "./core/storage.js";
import { getInternalJobs, loadUserJobs, saveUserJobs } from "./core/jobs.js";
import { loadEventState, loadImmediateEvents, removeImmediateEvent, saveEventState } from "./core/events.js";
import { runDreamJob } from "./core/dream-job.js";
import type { ImmediateEvent, InternalScheduledJob, UserScheduledJob } from "./types/job.js";
import { createAgentRuntime } from "./core/runtime.js";
import { computeNextRunAt, isDueUserJob, isExpiredOneShotJob } from "./core/job-schedule.js";

const agentId = process.env.MESO_AGENT_ID || process.env.MESO_DEFAULT_AGENT || "rex";
const TICK_MS = 30_000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CATCHUP_MINUTES = 4 * 60; // fire missed jobs if overdue by less than this
const runningJobs = new Set<string>();
const runningEvents = new Set<string>();
let tickInProgress = false;

function now(): Date {
  return new Date();
}

function shouldRunInternalJob(job: InternalScheduledJob, state: Record<string, { lastRunAt?: string }>): boolean {
  const everyMs = job.schedule.everyHours * 3_600_000;
  const last = state[job.id]?.lastRunAt ? new Date(state[job.id]!.lastRunAt!).getTime() : 0;
  return Date.now() - last >= everyMs;
}

function loadInternalState(statePath: string): Record<string, { lastRunAt?: string; lastStatus?: string; lastError?: string }> {
  try { return JSON.parse(fs.readFileSync(statePath, "utf-8")); } catch { return {}; }
}

function saveInternalState(statePath: string, state: Record<string, { lastRunAt?: string; lastStatus?: string; lastError?: string }>): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { if (timeoutId) clearTimeout(timeoutId); }
}

async function runPrompt(agentId: string, prompt: string, label: string): Promise<void> {
  const sessionId = `${label}-${Date.now()}`;
  const runtime = await createAgentRuntime(agentId, sessionId, "scheduled");
  await withTimeout(runtime.prompt(prompt), JOB_TIMEOUT_MS, label);
}

async function runUserJob(agentId: string, job: UserScheduledJob): Promise<{ status: "success" | "error" | "skipped" | "expired"; error?: string }> {
  console.log(`[scheduler:${agentId}] user job due: ${job.id} (${job.kind})`);
  if (job.kind !== "agent-prompt") return { status: "skipped", error: `Unsupported job kind: ${job.kind}` };
  if (!job.prompt?.trim()) return { status: "skipped", error: "Job prompt is empty" };
  if (job.schedule.type === "once" && isExpiredOneShotJob(job, new Date())) return { status: "expired", error: "One-shot job expired before it could run" };
  if (runningJobs.has(job.id)) return { status: "skipped", error: `Job ${job.id} is already running` };
  runningJobs.add(job.id);
  try {
    await runPrompt(agentId, job.prompt, `scheduled-job-${job.id}`);
    return { status: "success" };
  } finally {
    runningJobs.delete(job.id);
  }
}

async function runImmediateEvent(agentId: string, event: ImmediateEvent): Promise<{ status: "success" | "error" | "skipped" | "expired"; error?: string }> {
  if (!event.prompt?.trim()) return { status: "skipped", error: "Event prompt is empty" };
  if (event.expiresAt && new Date(event.expiresAt).getTime() < Date.now()) return { status: "expired", error: "Event expired before execution" };
  const dedupeKey = event.dedupeKey || event.id;
  if (runningEvents.has(dedupeKey)) return { status: "skipped", error: `Event ${dedupeKey} is already running` };
  runningEvents.add(dedupeKey);
  try {
    await runPrompt(agentId, event.prompt, `event-${event.id}`);
    return { status: "success" };
  } finally {
    runningEvents.delete(dedupeKey);
  }
}

async function tick(): Promise<void> {
  if (tickInProgress) {
    console.log(`[scheduler:${agentId}] previous tick still running, skipping overlap`);
    return;
  }
  tickInProgress = true;
  try {
    loadAgentEnvFile(agentId);
    const agent = loadAgent(agentId);
    configureAgentEnvironment(agentId, agent.paths, agent.configPath);

    const current = now();
    const userJobs = loadUserJobs(agent);
    const internalJobs = getInternalJobs();
    const pendingEvents = loadImmediateEvents(agent);
    const eventState = loadEventState(agent);
    const internalStatePath = path.join(agent.paths.logsDir, "scheduler-state.json");
    const internalState = loadInternalState(internalStatePath);

    let userJobsChanged = false;
    let internalChanged = false;
    let eventStateChanged = false;

    for (const loaded of pendingEvents) {
      const dedupeKey = loaded.event.dedupeKey || loaded.event.id;
      if (eventState.processed[dedupeKey]) {
        removeImmediateEvent(loaded.filePath);
        continue;
      }
      let result: { status: "success" | "error" | "skipped" | "expired"; error?: string };
      try {
        result = await runImmediateEvent(agentId, loaded.event);
      } catch (error) {
        result = { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
      if (result.status === "success" || result.status === "expired") {
        eventState.processed[dedupeKey] = new Date().toISOString();
        removeImmediateEvent(loaded.filePath);
        eventStateChanged = true;
      } else if (result.status === "error") {
        eventState.errors[loaded.event.id] = { lastError: result.error || "Unknown error", lastAt: new Date().toISOString() };
        removeImmediateEvent(loaded.filePath);
        eventStateChanged = true;
      }
    }

    for (const job of internalJobs) {
      if (!job.enabled) continue;
      if (!shouldRunInternalJob(job, internalState)) continue;
      try {
        console.log(`[scheduler:${agentId}] running internal job ${job.id}`);
        if (job.kind === "dream") await runDreamJob(agentId);
        internalState[job.id] = { lastRunAt: new Date().toISOString(), lastStatus: "success" };
      } catch (error) {
        internalState[job.id] = { lastRunAt: new Date().toISOString(), lastStatus: "error", lastError: error instanceof Error ? error.message : String(error) };
        console.error(`[scheduler:${agentId}] internal job failed ${job.id}:`, error);
      }
      internalChanged = true;
    }

    for (const job of userJobs) {
      if (job.schedule.type === "once" && isExpiredOneShotJob(job, current) && job.enabled) {
        job.enabled = false;
        job.lastStatus = "expired";
        job.lastError = "One-shot job expired before execution";
        job.nextRunAt = undefined;
        userJobsChanged = true;
        continue;
      }

      // For recurring jobs with a stale nextRunAt: either fire as a catch-up run
      // (if within the catch-up window) or advance to the next cycle (if too old).
      // This handles the case where the scheduler was down when the job was due.
      if (job.enabled && job.schedule.type !== "once" && job.nextRunAt) {
        const nextMs = new Date(job.nextRunAt).getTime();
        if (!Number.isNaN(nextMs) && current.getTime() > nextMs) {
          const alreadyRan = job.lastRunAt && new Date(job.lastRunAt).getTime() >= nextMs;
          if (alreadyRan) {
            // nextRunAt wasn't advanced after the last run (e.g. process was killed mid-write) — fix it now
            job.nextRunAt = computeNextRunAt(job.schedule, current, job.lastRunAt);
            job.updatedAt = current.toISOString();
            userJobsChanged = true;
            continue;
          }
          const catchupMs = (job.policy?.maxCatchupMinutes ?? DEFAULT_CATCHUP_MINUTES) * 60_000;
          const overdueMs = current.getTime() - nextMs;
          if (overdueMs > catchupMs) {
            // Too far past the scheduled window — skip this occurrence and move on
            console.log(`[scheduler:${agentId}] job ${job.id} missed window by ${Math.round(overdueMs / 60_000)}min (catchup limit ${job.policy?.maxCatchupMinutes ?? DEFAULT_CATCHUP_MINUTES}min), advancing to next cycle`);
            job.nextRunAt = computeNextRunAt(job.schedule, current, job.lastRunAt);
            job.updatedAt = current.toISOString();
            userJobsChanged = true;
            continue;
          }
          // Within catch-up window — fall through and fire the job late
          console.log(`[scheduler:${agentId}] job ${job.id} catch-up run (overdue by ${Math.round(overdueMs / 60_000)}min)`);
        }
      }

      if (!isDueUserJob(job, current)) continue;
      let result: { status: "success" | "error" | "skipped" | "expired"; error?: string };
      try { result = await runUserJob(agentId, job); } catch (error) { result = { status: "error", error: error instanceof Error ? error.message : String(error) }; }
      job.lastRunAt = new Date().toISOString();
      job.lastStatus = result.status;
      job.lastError = result.error;
      job.updatedAt = new Date().toISOString();
      if (job.schedule.type === "once") {
        job.nextRunAt = undefined;
        if (result.status === "success" || result.status === "error" || result.status === "expired") job.enabled = false;
      } else {
        job.nextRunAt = computeNextRunAt(job.schedule, current, job.lastRunAt);
      }
      userJobsChanged = true;
    }

    if (userJobsChanged) saveUserJobs(agent, userJobs);
    if (internalChanged) saveInternalState(internalStatePath, internalState);
    if (eventStateChanged) saveEventState(agent, eventState);
  } finally {
    tickInProgress = false;
  }
}

async function main(): Promise<void> {
  console.log(`[scheduler:${agentId}] starting`);
  await tick();
  setInterval(() => { tick().catch((error) => { console.error(`[scheduler:${agentId}] tick failed:`, error); }); }, TICK_MS);
}

main().catch((error) => {
  console.error(`[scheduler:${agentId}] fatal:`, error);
  process.exit(1);
});
