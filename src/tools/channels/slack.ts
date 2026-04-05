import { Type } from "@sinclair/typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { loadAgent } from "../../core/agent-loader.js";

async function postSlackMessage(agentId: string, channel: string, text: string, threadTs?: string): Promise<void> {
  const agent = loadAgent(agentId);
  const slack = agent.config.runners?.slack;
  if (!slack?.enabled) throw new Error(`Slack channel provider not enabled for ${agentId}`);
  const botToken = process.env[slack.botTokenEnv];
  if (!botToken) throw new Error(`Missing Slack bot token env: ${slack.botTokenEnv}`);

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
  const data = await response.json() as any;
  if (!data.ok) throw new Error(`Slack post failed: ${data.error || response.status}`);
}

export function createSlackChannelTools(agentId: string): any[] {
  const slackPostMessageTool = defineTool({
    name: "slack_post_message",
    label: "Slack Post Message",
    description: `Post a message to Slack.

Use this when you need to deliver a result, report, reminder, or scheduled update into Slack.
The prompt should specify the destination explicitly, such as a channel ID and optional thread timestamp.

This is a channel-specific communication tool. More communication channels can be added later using the same pattern.`,
    parameters: Type.Object({
      channel: Type.String({ description: "Slack channel ID, for example C12345678" }),
      text: Type.String({ description: "The message text to send" }),
      threadTs: Type.Optional(Type.String({ description: "Optional Slack thread timestamp to reply in-thread" })),
    }),
    async execute(_toolCallId, params) {
      await postSlackMessage(agentId, params.channel, params.text, params.threadTs);
      return {
        content: [{ type: "text" as const, text: `Posted message to Slack channel ${params.channel}${params.threadTs ? ` thread ${params.threadTs}` : ""}.` }],
      };
    },
  });

  return [slackPostMessageTool];
}
