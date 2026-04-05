import { loadAgent } from "../../core/agent-loader.js";
import { getEnabledChannelProviders } from "../../core/channel-providers.js";
import { createSlackChannelTools } from "./slack.js";

export function createChannelTools(agentId: string): any[] {
  const agent = loadAgent(agentId);
  const tools: any[] = [];
  const providers = getEnabledChannelProviders(agent);

  if (providers.includes("slack")) {
    tools.push(...createSlackChannelTools(agentId));
  }

  return tools;
}
