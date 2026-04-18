import type { UserJobSchedule, UserJobWeekday, UserScheduledJob } from "../types/job.js";

const WEEKDAY_MAP: Record<UserJobWeekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export const DEFAULT_ONCE_STALENESS_MINUTES = 24 * 60;

export function isValidHm(value: string): boolean {
  return /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value);
}

export function parseHm(value: string): { hour: number; minute: number } | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function normalizeJobId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `job-${Date.now()}`;
}

function nextDailyAt(time: string, from = new Date()): string | undefined {
  const hm = parseHm(time);
  if (!hm) return undefined;
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hm.hour, hm.minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function nextWeekdayAt(days: UserJobWeekday[], time: string, from = new Date()): string | undefined {
  const hm = parseHm(time);
  if (!hm || days.length === 0) return undefined;
  const allowed = new Set(days.map((d) => WEEKDAY_MAP[d]));
  for (let offset = 0; offset < 14; offset++) {
    const candidate = new Date(from);
    candidate.setDate(from.getDate() + offset);
    candidate.setHours(hm.hour, hm.minute, 0, 0);
    if (!allowed.has(candidate.getDay())) continue;
    if (candidate.getTime() <= from.getTime()) continue;
    return candidate.toISOString();
  }
  return undefined;
}

function nextWeeklyAt(day: UserJobWeekday, time: string, from = new Date()): string | undefined {
  return nextWeekdayAt([day], time, from);
}

function nextIntervalAt(everyMinutes: number, from = new Date(), lastRunAt?: string): string | undefined {
  if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) return undefined;
  const base = lastRunAt ? new Date(lastRunAt) : from;
  if (Number.isNaN(base.getTime())) return undefined;
  return new Date(base.getTime() + everyMinutes * 60_000).toISOString();
}

export function computeNextRunAt(schedule: UserJobSchedule, from = new Date(), lastRunAt?: string): string | undefined {
  if (schedule.type === "daily") return nextDailyAt(schedule.time, from);
  if (schedule.type === "weekdays") return nextWeekdayAt(schedule.days, schedule.time, from);
  if (schedule.type === "weekly") return nextWeeklyAt(schedule.day, schedule.time, from);
  if (schedule.type === "interval") return nextIntervalAt(schedule.everyMinutes, from, lastRunAt);
  if (schedule.type === "once") return new Date(schedule.at).toString() === "Invalid Date" ? undefined : schedule.at;
  return undefined;
}

function isValidWeekdayArray(days: unknown): days is UserJobWeekday[] {
  return Array.isArray(days) && days.length > 0 && days.every((d) => typeof d === "string" && d in WEEKDAY_MAP);
}

export function isValidUserJob(input: any): input is UserScheduledJob {
  if (!input || typeof input.id !== "string" || input.kind !== "agent-prompt" || typeof input.enabled !== "boolean") return false;
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) return false;
  if (input.schedule?.type === "daily") return typeof input.schedule.time === "string" && isValidHm(input.schedule.time);
  if (input.schedule?.type === "weekdays") return typeof input.schedule.time === "string" && isValidHm(input.schedule.time) && isValidWeekdayArray(input.schedule.days);
  if (input.schedule?.type === "weekly") return typeof input.schedule.time === "string" && isValidHm(input.schedule.time) && typeof input.schedule.day === "string" && input.schedule.day in WEEKDAY_MAP;
  if (input.schedule?.type === "interval") return Number.isFinite(input.schedule.everyMinutes) && input.schedule.everyMinutes > 0;
  if (input.schedule?.type === "once") return typeof input.schedule.at === "string" && new Date(input.schedule.at).toString() !== "Invalid Date";
  return false;
}

export function normalizeUserJob(input: UserScheduledJob): UserScheduledJob {
  return {
    ...input,
    id: normalizeJobId(input.id),
    prompt: input.prompt?.trim(),
    nextRunAt: input.nextRunAt || computeNextRunAt(input.schedule, new Date(), input.lastRunAt),
  };
}

export function isExpiredOneShotJob(job: UserScheduledJob, current = new Date()): boolean {
  if (job.schedule.type !== "once") return false;
  const at = new Date(job.schedule.at).getTime();
  if (Number.isNaN(at)) return true;
  const maxStalenessMinutes = job.policy?.maxStalenessMinutes ?? DEFAULT_ONCE_STALENESS_MINUTES;
  return current.getTime() - at > maxStalenessMinutes * 60_000;
}

export function isDueUserJob(job: UserScheduledJob, current = new Date()): boolean {
  if (!job.enabled) return false;
  if (job.schedule.type === "once") {
    const at = new Date(job.schedule.at).getTime();
    if (Number.isNaN(at)) return false;
    if (current.getTime() < at) return false;
    if (isExpiredOneShotJob(job, current)) return false;
    if (!job.lastRunAt) return true;
    return new Date(job.lastRunAt).getTime() < at;
  }
  if (job.schedule.type === "interval") {
    if (!job.nextRunAt) return true;
    const next = new Date(job.nextRunAt).getTime();
    return !Number.isNaN(next) && current.getTime() >= next;
  }

  // daily/weekday/weekly: use nextRunAt as the canonical signal.
  // computeNextRunAt handles day-of-week filtering, so all we check here is
  // whether the scheduled time has arrived and we haven't run since it.
  // The scheduler tick handles advancing stale nextRunAt before calling this.
  if (!job.nextRunAt) return false;
  const nextMs = new Date(job.nextRunAt).getTime();
  if (Number.isNaN(nextMs) || current.getTime() < nextMs) return false;
  if (job.lastRunAt && new Date(job.lastRunAt).getTime() >= nextMs) return false;
  return true;
}
