import fs from "node:fs";
import path from "node:path";
import { loadAgent } from "../core/agent-loader.js";

export function runInspectAgent(agentId: string): void {
  const agent = loadAgent(agentId);
  const settingsPath = agent.paths.settingsFile;
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {}
  const skillsDir = path.join(agent.root, "skills");
  const summary = {
    id: agent.id,
    name: agent.config.name,
    description: agent.config.description || "",
    prompts: agent.config.prompts,
    models: agent.config.models,
    runners: agent.config.runners,
    tools: agent.config.tools,
    extensions: agent.config.extensions,
    piSettings: settings,
    skills: {
      dir: skillsDir,
      enabledPaths: settings.skills || [],
      enableSkillCommands: settings.enableSkillCommands ?? true,
    },
    paths: agent.paths,
  };
  console.log(JSON.stringify(summary, null, 2));
}
