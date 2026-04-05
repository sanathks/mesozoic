import { loadAgent, type LoadedAgent } from "./agent-loader.js";

export type ChannelProvider = "slack" | "discord" | "telegram";

export function getEnabledChannelProviders(agent: LoadedAgent): ChannelProvider[] {
  const providers: ChannelProvider[] = [];
  if (agent.config.runners?.slack?.enabled) providers.push("slack");
  if (agent.config.runners?.discord?.enabled) providers.push("discord");
  if (agent.config.runners?.telegram?.enabled) providers.push("telegram");
  return providers;
}

export function getEnabledChannelProvidersForAgent(agentId: string): ChannelProvider[] {
  return getEnabledChannelProviders(loadAgent(agentId));
}

export function hasSlackProvider(agent: LoadedAgent): boolean {
  return getEnabledChannelProviders(agent).includes("slack");
}
