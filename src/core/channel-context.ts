import type { ChannelProvider } from "./channel-providers.js";

export interface SlackChannelContext {
  channelId: string;
  threadTs?: string;
  userId?: string;
}

function linesToBlock(tag: string, lines: Array<[string, string | undefined]>): string {
  const body = lines
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `<${tag}>\n${body}\n</${tag}>`;
}

export function buildChannelContextBlock(provider: "slack", context: SlackChannelContext): string;
export function buildChannelContextBlock(provider: ChannelProvider, context: Record<string, string | undefined>): string {
  if (provider === "slack") {
    return linesToBlock("slack_context", [
      ["channel_id", context.channelId],
      ["thread_ts", context.threadTs],
      ["user_id", context.userId],
    ]);
  }
  if (provider === "discord") {
    return linesToBlock("discord_context", Object.entries(context));
  }
  if (provider === "telegram") {
    return linesToBlock("telegram_context", Object.entries(context));
  }
  return linesToBlock("channel_context", Object.entries(context));
}
