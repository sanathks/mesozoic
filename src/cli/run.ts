import { runChannelAgent, type ChannelProvider } from "../core/channel-runner.js";
import { runTuiAgent } from "../core/tui-runner.js";
import { loadAgentEnvFile } from "../core/storage.js";

export async function runAgent(agentId: string, mode: "channel" | "tui", provider?: ChannelProvider): Promise<void> {
  loadAgentEnvFile(agentId);
  if (mode === "channel") return runChannelAgent(agentId, provider);
  return runTuiAgent(agentId);
}
