import fs from "node:fs";
import path from "node:path";
import type { LoadedAgent } from "./agent-loader.js";
import type { InternalScheduledJob, UserScheduledJob } from "../types/job.js";
import { isValidUserJob, normalizeUserJob } from "./job-schedule.js";

export function ensureJobsFile(agent: LoadedAgent): void {
  if (!fs.existsSync(agent.paths.jobsFile)) {
    fs.mkdirSync(path.dirname(agent.paths.jobsFile), { recursive: true });
    fs.writeFileSync(agent.paths.jobsFile, "[]\n");
  }
}

export function loadUserJobs(agent: LoadedAgent): UserScheduledJob[] {
  ensureJobsFile(agent);
  try {
    const parsed = JSON.parse(fs.readFileSync(agent.paths.jobsFile, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidUserJob).map(normalizeUserJob);
  } catch {
    return [];
  }
}

export function saveUserJobs(agent: LoadedAgent, jobs: UserScheduledJob[]): void {
  fs.mkdirSync(path.dirname(agent.paths.jobsFile), { recursive: true });
  fs.writeFileSync(agent.paths.jobsFile, JSON.stringify(jobs.map(normalizeUserJob), null, 2) + "\n");
}

export function getInternalJobs(): InternalScheduledJob[] {
  return [
    {
      id: "dream-daily",
      enabled: true,
      kind: "dream",
      schedule: {
        type: "interval-hours",
        everyHours: 20,
      },
    },
  ];
}
