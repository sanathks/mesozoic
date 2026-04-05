import { listAgents } from "../core/agent-loader.js";

export function runListAgents(): void {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log("No agents found.");
    return;
  }
  for (const agent of agents) console.log(agent);
}
