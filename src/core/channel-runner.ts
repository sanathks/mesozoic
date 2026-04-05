import { runSlackChannel } from "./slack-runner.js";
import { getEnabledChannelProvidersForAgent, type ChannelProvider } from "./channel-providers.js";

export async function runChannelAgent(agentId: string, provider?: ChannelProvider): Promise<void> {
  const enabled = getEnabledChannelProvidersForAgent(agentId);
  const chosen = provider || (enabled.length === 1 ? enabled[0] : null);
  if (!chosen) {
    throw new Error(`[meso] Multiple or no channel providers configured for ${agentId}. Use --provider slack|discord|telegram or configure exactly one channel provider.`);
  }
  if (!enabled.includes(chosen)) {
    throw new Error(`[meso] Channel provider ${chosen} is not enabled for ${agentId}`);
  }

  if (chosen === "slack") return runSlackChannel(agentId);
  if (chosen === "discord") throw new Error(`[meso] Discord channel runner not implemented yet for ${agentId}`);
  if (chosen === "telegram") throw new Error(`[meso] Telegram channel runner not implemented yet for ${agentId}`);
  throw new Error(`[meso] Unknown channel provider: ${chosen}`);
}
