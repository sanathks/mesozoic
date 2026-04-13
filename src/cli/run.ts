import { runChannelAgent, type ChannelProvider } from "../core/channel-runner.js";
import { runTuiAgent } from "../core/tui-runner.js";
import { runVoiceAgent } from "../core/voice-runner.js";
import { loadAgentEnvFile } from "../core/storage.js";

export async function runAgent(agentId: string, mode: "channel" | "tui" | "voice", provider?: ChannelProvider): Promise<void> {
  loadAgentEnvFile(agentId);
  if (mode === "channel") return runChannelAgent(agentId, provider);
  if (mode === "voice") return runVoiceAgent(agentId);
  return runTuiAgent(agentId);
}
