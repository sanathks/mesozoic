import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadAgent } from "../core/agent-loader.js";
import { getEnabledChannelProviders } from "../core/channel-providers.js";
import { loadUserJobs } from "../core/jobs.js";
import { getChannelLogsRoot } from "../core/channel-log.js";
import { loadImmediateEvents } from "../core/events.js";
import { getStatus } from "../daemon/daemon.js";

function ok(message: string): void {
  console.log(`OK   ${message}`);
}

function warn(message: string): void {
  console.log(`WARN ${message}`);
}

function info(message: string): void {
  console.log(`INFO ${message}`);
}

function getStrayMatches(pattern: string): string[] {
  try {
    return execSync(`pgrep -af ${JSON.stringify(pattern)}`, { stdio: ["ignore", "pipe", "ignore"], shell: "/bin/bash" })
      .toString("utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function runDoctor(agentId: string): void {
  const agent = loadAgent(agentId);
  const envPath = path.join(agent.root, ".env");
  const slack = agent.config.runners?.slack;
  const enabledProviders = getEnabledChannelProviders(agent);

  console.log(`Meso doctor for ${agentId}\n`);

  ok(`agent config: ${agent.configPath}`);

  if (fs.existsSync(envPath)) ok(`agent .env present: ${envPath}`);
  else warn(`agent .env missing: ${envPath}`);

  for (const promptFile of [agent.config.prompts.identity, agent.config.prompts.soul, ...(agent.config.prompts.extra || [])]) {
    const p = path.join(agent.root, promptFile);
    if (fs.existsSync(p)) ok(`prompt file present: ${p}`);
    else warn(`prompt file missing: ${p}`);
  }

  // Check daemon processes
  const statuses = getStatus().filter((s) => s.agentId === agentId);
  if (statuses.length === 0) {
    warn(`no running processes for ${agentId}`);
  } else {
    for (const proc of statuses) {
      info(`${proc.name}: status=${proc.status} pid=${proc.pid} uptime=${proc.uptime} restarts=${proc.restarts} memory=${proc.memory}`);
    }
  }

  if (enabledProviders.length > 0) {
    ok(`channel providers enabled: ${enabledProviders.join(", ")}`);
  } else {
    warn(`no channel providers enabled`);
  }

  if (slack?.enabled) {
    const required = [slack.botTokenEnv, slack.appTokenEnv, slack.signingSecretEnv].filter(Boolean) as string[];
    for (const name of required) {
      if (process.env[name]) ok(`env available: ${name}`);
      else if (fs.existsSync(envPath) && fs.readFileSync(envPath, "utf-8").includes(`${name}=`)) ok(`env defined in agent .env: ${name}`);
      else warn(`missing env: ${name}`);
    }
  }

  const userJobs = loadUserJobs(agent);
  ok(`user jobs loaded: ${userJobs.length}`);
  for (const job of userJobs) {
    info(`job ${job.id}: schedule=${job.schedule.type} next=${job.nextRunAt || "none"} status=${job.lastStatus || "never"}`);
  }

  const pendingEvents = loadImmediateEvents(agent);
  ok(`pending immediate events: ${pendingEvents.length}`);
  info(`events dir: ${agent.paths.eventsDir}`);
  info(`event state file: ${agent.paths.eventStateFile}`);
  if (fs.existsSync(agent.paths.eventStateFile)) ok(`event state present: ${agent.paths.eventStateFile}`);
  else warn(`event state missing: ${agent.paths.eventStateFile}`);

  if ((agent.config.tools?.enabled || []).includes("search")) {
    if (process.env.TAVILY_API_KEY) ok("env available: TAVILY_API_KEY");
    else if (fs.existsSync(envPath) && fs.readFileSync(envPath, "utf-8").includes("TAVILY_API_KEY=")) ok("env defined in agent .env: TAVILY_API_KEY");
    else warn("search enabled but TAVILY_API_KEY is missing");
  }

  const skillsDir = path.join(agent.root, "skills");
  if (fs.existsSync(skillsDir)) ok(`skills dir present: ${skillsDir}`);
  else warn(`skills dir missing: ${skillsDir}`);

  const channelLogsRoot = getChannelLogsRoot(agent.paths);
  info(`channel transcript root: ${channelLogsRoot}`);

  const stray = getStrayMatches(`meso run ${agentId} --slack|meso run ${agentId} --channel|node.*src/index.ts|tsx .*src/index.ts`)
    .filter((line) => !line.includes("doctor") && !line.includes("supervisor"));
  if (stray.length > 0) {
    warn(`possible stray processes:`);
    for (const line of stray) console.log(`     ${line}`);
  } else {
    ok("no obvious stray legacy processes found");
  }
}
