import { Type } from "@sinclair/typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { loadAgent } from "../core/agent-loader.js";
import { loadUserJobs, saveUserJobs } from "../core/jobs.js";
import { loadImmediateEvents, removeImmediateEvent, writeImmediateEvent } from "../core/events.js";
import type { ImmediateEvent, UserJobWeekday, UserScheduledJob } from "../types/job.js";
import { computeNextRunAt, isValidHm, normalizeJobId } from "../core/job-schedule.js";

function formatSchedule(job: UserScheduledJob): string {
  if (job.schedule.type === "daily") return `daily ${job.schedule.time}${job.schedule.timezone ? ` ${job.schedule.timezone}` : ""}`;
  if (job.schedule.type === "weekdays") return `weekdays(${job.schedule.days.join(",")}) ${job.schedule.time}${job.schedule.timezone ? ` ${job.schedule.timezone}` : ""}`;
  if (job.schedule.type === "weekly") return `weekly(${job.schedule.day}) ${job.schedule.time}${job.schedule.timezone ? ` ${job.schedule.timezone}` : ""}`;
  if (job.schedule.type === "interval") return `every ${job.schedule.everyMinutes} minutes`;
  return `once ${job.schedule.at}`;
}

function formatJob(job: UserScheduledJob): string {
  return [
    `- ${job.id}`,
    `  enabled: ${job.enabled}`,
    `  schedule: ${formatSchedule(job)}`,
    `  next run: ${job.nextRunAt || "unknown"}`,
    `  last status: ${job.lastStatus || "never"}`,
    `  prompt: ${job.prompt || ""}`,
  ].join("\n");
}

export function createSchedulerTools(agentId: string) {
  const scheduleJobTool = defineTool({
    name: "schedule_job",
    label: "Schedule Job",
    description: `Create or update a scheduled user job for this agent.

Use this when the user asks you to proactively do something later or on a schedule.
Each job stores a self-contained prompt. When the job becomes due, the scheduler will run the main agent on that saved prompt.

Current supported schedules:
- daily at HH:MM
- selected weekdays at HH:MM
- weekly on one day at HH:MM
- interval every N minutes
- one-time at an ISO timestamp`,
    parameters: Type.Object({
      id: Type.String({ description: "Stable short job id, like german-news or morning-briefing" }),
      prompt: Type.String({ description: "The exact self-contained prompt the scheduler should run later" }),
      scheduleType: Type.Optional(Type.Union([Type.Literal("daily"), Type.Literal("weekdays"), Type.Literal("weekly"), Type.Literal("interval"), Type.Literal("once") ])),
      time: Type.Optional(Type.String({ description: "HH:MM 24-hour format for daily/weekdays/weekly schedules" })),
      days: Type.Optional(Type.Array(Type.Union([Type.Literal("sun"), Type.Literal("mon"), Type.Literal("tue"), Type.Literal("wed"), Type.Literal("thu"), Type.Literal("fri"), Type.Literal("sat")]), { description: "Weekdays for scheduleType=weekdays" })),
      day: Type.Optional(Type.Union([Type.Literal("sun"), Type.Literal("mon"), Type.Literal("tue"), Type.Literal("wed"), Type.Literal("thu"), Type.Literal("fri"), Type.Literal("sat")], { description: "Day for scheduleType=weekly" })),
      everyMinutes: Type.Optional(Type.Number({ description: "Interval in minutes for scheduleType=interval" })),
      at: Type.Optional(Type.String({ description: "ISO timestamp for one-time jobs" })),
      timezone: Type.Optional(Type.String({ description: "Optional timezone label" })),
      enabled: Type.Optional(Type.Boolean()),
      maxStalenessMinutes: Type.Optional(Type.Number({ description: "Optional stale cutoff for one-shot jobs" })),
    }),
    async execute(_toolCallId, params) {
      const scheduleType = params.scheduleType || "daily";
      let schedule: UserScheduledJob["schedule"];

      if (scheduleType === "daily") {
        if (!params.time || !isValidHm(params.time)) return { content: [{ type: "text" as const, text: "Error: daily schedules require time in HH:MM format." }] };
        schedule = { type: "daily", time: params.time, timezone: params.timezone };
      } else if (scheduleType === "weekdays") {
        if (!params.time || !isValidHm(params.time)) return { content: [{ type: "text" as const, text: "Error: weekday schedules require time in HH:MM format." }] };
        const days = (params.days || ["mon", "tue", "wed", "thu", "fri"]) as UserJobWeekday[];
        if (days.length === 0) return { content: [{ type: "text" as const, text: "Error: weekday schedules require at least one day." }] };
        schedule = { type: "weekdays", time: params.time, days, timezone: params.timezone };
      } else if (scheduleType === "weekly") {
        if (!params.time || !isValidHm(params.time) || !params.day) return { content: [{ type: "text" as const, text: "Error: weekly schedules require a day and time in HH:MM format." }] };
        schedule = { type: "weekly", day: params.day as UserJobWeekday, time: params.time, timezone: params.timezone };
      } else if (scheduleType === "interval") {
        if (!params.everyMinutes || params.everyMinutes <= 0) return { content: [{ type: "text" as const, text: "Error: interval schedules require everyMinutes > 0." }] };
        schedule = { type: "interval", everyMinutes: Math.floor(params.everyMinutes) };
      } else {
        if (!params.at || new Date(params.at).toString() === "Invalid Date") return { content: [{ type: "text" as const, text: "Error: one-time schedules require a valid ISO timestamp in 'at'." }] };
        schedule = { type: "once", at: params.at };
      }

      const agent = loadAgent(agentId);
      const jobs = loadUserJobs(agent);
      const jobId = normalizeJobId(params.id);
      const existing = jobs.find((job) => job.id === jobId);
      const nowIso = new Date().toISOString();
      const job: UserScheduledJob = {
        id: jobId,
        enabled: params.enabled ?? true,
        kind: "agent-prompt",
        schedule,
        prompt: params.prompt.trim(),
        nextRunAt: computeNextRunAt(schedule),
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
        policy: schedule.type === "once" && params.maxStalenessMinutes ? { maxStalenessMinutes: Math.floor(params.maxStalenessMinutes), retryOnError: false } : existing?.policy,
        lastStatus: existing?.lastStatus,
        lastError: existing?.lastError,
        lastRunAt: existing?.lastRunAt,
      };
      if (existing) jobs[jobs.findIndex((entry) => entry.id === jobId)] = job; else jobs.push(job);
      saveUserJobs(agent, jobs);
      return { content: [{ type: "text" as const, text: `${existing ? "Updated" : "Scheduled"} job '${jobId}' with schedule ${formatSchedule(job)}.` }] };
    },
  });

  const listJobsTool = defineTool({
    name: "list_jobs",
    label: "List Jobs",
    description: "List user-defined scheduled jobs for this agent.",
    parameters: Type.Object({ includeDisabled: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      const agent = loadAgent(agentId);
      const jobs = loadUserJobs(agent).filter((job) => params.includeDisabled || job.enabled);
      if (jobs.length === 0) return { content: [{ type: "text" as const, text: "No scheduled user jobs found." }] };
      return { content: [{ type: "text" as const, text: `Scheduled jobs:\n${jobs.map(formatJob).join("\n")}` }] };
    },
  });

  const pauseJobTool = defineTool({
    name: "pause_job",
    label: "Pause Job",
    description: "Pause a user-defined scheduled job by id without deleting it.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params) {
      const agent = loadAgent(agentId);
      const jobs = loadUserJobs(agent);
      const job = jobs.find((entry) => entry.id === params.id);
      if (!job) return { content: [{ type: "text" as const, text: `No job found with id '${params.id}'.` }] };
      job.enabled = false;
      job.updatedAt = new Date().toISOString();
      saveUserJobs(agent, jobs);
      return { content: [{ type: "text" as const, text: `Paused job '${params.id}'.` }] };
    },
  });

  const resumeJobTool = defineTool({
    name: "resume_job",
    label: "Resume Job",
    description: "Resume a paused user-defined scheduled job by id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params) {
      const agent = loadAgent(agentId);
      const jobs = loadUserJobs(agent);
      const job = jobs.find((entry) => entry.id === params.id);
      if (!job) return { content: [{ type: "text" as const, text: `No job found with id '${params.id}'.` }] };
      job.enabled = true;
      job.updatedAt = new Date().toISOString();
      job.nextRunAt = computeNextRunAt(job.schedule, new Date(), job.lastRunAt);
      saveUserJobs(agent, jobs);
      return { content: [{ type: "text" as const, text: `Resumed job '${params.id}'.` }] };
    },
  });

  const removeJobTool = defineTool({
    name: "remove_job",
    label: "Remove Job",
    description: "Remove a user-defined scheduled job by id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params) {
      const agent = loadAgent(agentId);
      const jobs = loadUserJobs(agent);
      const after = jobs.filter((job) => job.id !== params.id);
      if (after.length === jobs.length) return { content: [{ type: "text" as const, text: `No job found with id '${params.id}'.` }] };
      saveUserJobs(agent, after);
      return { content: [{ type: "text" as const, text: `Removed job '${params.id}'.` }] };
    },
  });

  const triggerEventTool = defineTool({
    name: "trigger_event",
    label: "Trigger Event",
    description: "Create an immediate event for this agent. Use this for external/reactive work that should run as soon as possible.",
    parameters: Type.Object({
      id: Type.String(),
      prompt: Type.String(),
      dedupeKey: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      expiresAt: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const agent = loadAgent(agentId);
      const event: ImmediateEvent = {
        id: normalizeJobId(params.id),
        type: "immediate",
        prompt: params.prompt.trim(),
        createdAt: new Date().toISOString(),
        dedupeKey: params.dedupeKey,
        source: params.source,
        expiresAt: params.expiresAt,
      };
      const filePath = writeImmediateEvent(agent, event);
      return { content: [{ type: "text" as const, text: `Queued immediate event '${event.id}' at ${filePath}.` }] };
    },
  });

  const listEventsTool = defineTool({
    name: "list_events",
    label: "List Events",
    description: "List pending immediate events in the agent inbox.",
    parameters: Type.Object({}),
    async execute() {
      const agent = loadAgent(agentId);
      const events = loadImmediateEvents(agent);
      if (events.length === 0) return { content: [{ type: "text" as const, text: "No pending immediate events found." }] };
      return { content: [{ type: "text" as const, text: events.map(({ event }) => `- ${event.id}\n  created: ${event.createdAt}\n  source: ${event.source || "unknown"}\n  dedupe: ${event.dedupeKey || "none"}\n  prompt: ${event.prompt}`).join("\n") }] };
    },
  });

  const removeEventTool = defineTool({
    name: "remove_event",
    label: "Remove Event",
    description: "Remove a pending immediate event by id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params) {
      const agent = loadAgent(agentId);
      const events = loadImmediateEvents(agent);
      const found = events.find(({ event }) => event.id === params.id);
      if (!found) return { content: [{ type: "text" as const, text: `No pending event found with id '${params.id}'.` }] };
      removeImmediateEvent(found.filePath);
      return { content: [{ type: "text" as const, text: `Removed pending event '${params.id}'.` }] };
    },
  });

  return [scheduleJobTool, listJobsTool, pauseJobTool, resumeJobTool, removeJobTool, triggerEventTool, listEventsTool, removeEventTool];
}
