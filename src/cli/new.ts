import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { ensureMesoHome, getAgentRoot } from "../core/storage.js";
import { runLogin } from "./auth.js";
import { CURRENT_CONFIG_VERSION } from "./upgrade.js";

function upperEnvPrefix(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

function titleCase(agentName: string): string {
  return agentName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function writeAgentEnv(root: string, values: Record<string, string>): string | null {
  const entries = Object.entries(values).filter(([, value]) => value.trim().length > 0);
  if (entries.length === 0) return null;
  const content = entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
  const envPath = path.join(root, ".env");
  fs.writeFileSync(envPath, content);
  return envPath;
}

export interface NewAgentOptions {
  displayName?: string;
  slackEnabled?: boolean;
  searchEnabled?: boolean;
}

export function createAgentScaffold(agentName: string, options: NewAgentOptions = {}): string {
  ensureMesoHome();
  const root = getAgentRoot(agentName);
  if (fs.existsSync(root)) throw new Error(`[meso] Agent already exists: ${agentName}`);
  const envPrefix = upperEnvPrefix(agentName);
  const displayName = options.displayName || titleCase(agentName);
  const slackEnabled = options.slackEnabled ?? true;
  const searchEnabled = options.searchEnabled ?? true;

  // User-visible dirs
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.mkdirSync(path.join(root, "events"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
  // System dir
  fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });

  const agentConfig = {
    configVersion: CURRENT_CONFIG_VERSION,
    id: agentName,
    name: displayName,
    description: `${displayName} agent running on Meso`,
    prompts: {
      identity: "IDENTITY.md",
      soul: "SOUL.md",
      extra: ["COMMS.md"],
    },
    models: {
      main: [
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "anthropic", id: "claude-haiku-4-5" }
      ],
      side: { provider: "openai-codex", id: "gpt-5.4-mini" },
    },
    runners: {
      slack: {
        enabled: slackEnabled,
        botTokenEnv: `${envPrefix}_SLACK_BOT_TOKEN`,
        appTokenEnv: `${envPrefix}_SLACK_APP_TOKEN`,
        signingSecretEnv: `${envPrefix}_SLACK_SIGNING_SECRET`,
        mode: "assistant",
      },
      tui: { enabled: true },
    },
    tools: { enabled: searchEnabled ? ["memory", "search"] : ["memory"] },
    extensions: { enabled: ["guardrails"] },
    memory: { enabled: true, maxRelevantItems: 8 },
    guardrails: {
      enabled: true,
      projectConfig: "__RUNTIME__/guardrails.json",
      localConfig: "guardrails.local.json",
    },
    behavior: {
      progressUpdates: "single-message",
      stopWord: "stop",
      continuousDmSession: true,
    },
    runtime: {
      thinking: "off",
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000 },
    },
  };

  fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify(agentConfig, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "IDENTITY.md"), `# Identity\n\nYou are ${displayName}.\n\nState clearly who you are, what you help with, and your role.\n`);
  fs.writeFileSync(path.join(root, "SOUL.md"), `# Soul\n\nYour core values:\n- be useful\n- be calm\n- be precise\n- use tools when needed\n`);
  fs.writeFileSync(path.join(root, "COMMS.md"), `# Communication\n\n- be concise\n- prefer clear structure\n- ask focused follow-up questions when needed\n`);
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({
    skills: ["./skills"],
    enableSkillCommands: true,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "jobs.json"), JSON.stringify([], null, 2) + "\n");
  fs.writeFileSync(path.join(root, "guardrails.local.json"), JSON.stringify({ allowedPaths: [process.cwd()] }, null, 2) + "\n");
  fs.writeFileSync(
    path.join(root, "tools", "README.md"),
    "Put agent-specific tool extensions here. These files use Pi's extension API under the hood and can register custom tools, commands, and hooks for this agent only.\n",
  );
  fs.writeFileSync(
    path.join(root, "skills", "README.md"),
    "Put agent-specific Pi skills here. Each skill should live in its own directory with a SKILL.md file. Add helper scripts, references, and assets next to it as needed.\n",
  );

  return root;
}

export async function runNewAgentWizard(agentName: string): Promise<string> {
  p.intro(`New agent: ${agentName}`);

  const config = await p.group(
    {
      displayName: () =>
        p.text({
          message: "Display name",
          placeholder: titleCase(agentName),
          defaultValue: titleCase(agentName),
        }),
      slackEnabled: () => p.confirm({ message: "Enable Slack?", initialValue: true }),
      searchEnabled: () => p.confirm({ message: "Enable web search?", initialValue: true }),
    },
    { onCancel: () => { p.cancel("Cancelled."); process.exit(0); } },
  );

  const root = createAgentScaffold(agentName, {
    displayName: config.displayName,
    slackEnabled: config.slackEnabled,
    searchEnabled: config.searchEnabled,
  });

  const envPrefix = upperEnvPrefix(agentName);
  const envValues: Record<string, string> = {};

  if (config.slackEnabled) {
    p.log.info("Slack tokens (leave empty to fill in later)");
    const slack = await p.group(
      {
        botToken: () => p.text({ message: `${envPrefix}_SLACK_BOT_TOKEN`, placeholder: "xoxb-..." }),
        appToken: () => p.text({ message: `${envPrefix}_SLACK_APP_TOKEN`, placeholder: "xapp-..." }),
        signingSecret: () => p.text({ message: `${envPrefix}_SLACK_SIGNING_SECRET`, placeholder: "optional" }),
      },
      { onCancel: () => { p.cancel("Cancelled."); process.exit(0); } },
    );
    envValues[`${envPrefix}_SLACK_BOT_TOKEN`] = slack.botToken || "";
    envValues[`${envPrefix}_SLACK_APP_TOKEN`] = slack.appToken || "";
    envValues[`${envPrefix}_SLACK_SIGNING_SECRET`] = slack.signingSecret || "";
  }

  if (config.searchEnabled) {
    const tavilyKey = await p.text({ message: "TAVILY_API_KEY", placeholder: "tvly-... (optional)" });
    if (!p.isCancel(tavilyKey)) envValues.TAVILY_API_KEY = tavilyKey || "";
  }

  const envPath = writeAgentEnv(root, envValues);

  // Check existing auth — skip login prompt if already authenticated
  const { createAuthStorage } = await import("../config.js");
  const authStorage = createAuthStorage();
  const existingProviders = authStorage.list();
  if (existingProviders.length > 0) {
    p.log.success(`Using existing auth: ${existingProviders.join(", ")}`);
  } else {
    const login = await p.confirm({ message: "No model providers authenticated. Login now?", initialValue: true });
    if (!p.isCancel(login) && login) {
      await runLogin();
    }
  }

  const startNow = await p.confirm({ message: "Start agent now?", initialValue: true });
  if (!p.isCancel(startNow) && startNow) {
    const { startAgent } = await import("../daemon/daemon.js");
    startAgent(agentName);
  }

  p.note(
    [
      `Agent:    ${agentName}`,
      `Name:     ${config.displayName}`,
      `Path:     ${root}`,
      `Slack:    ${config.slackEnabled ? "enabled" : "disabled"}`,
      `Search:   ${config.searchEnabled ? "enabled" : "disabled"}`,
      `Env file: ${envPath || "not written"}`,
    ].join("\n"),
    "Created",
  );

  p.outro(`${agentName} is ready`);
  return root;
}
