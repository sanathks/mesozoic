import { Type } from "@sinclair/typebox";
import { tavily } from "@tavily/core";
import { defineTool } from "@mariozechner/pi-coding-agent";

const client = process.env.TAVILY_API_KEY
  ? tavily({ apiKey: process.env.TAVILY_API_KEY })
  : null;

export const searchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description:
    "Search the internet for current information. Use this when you need up-to-date information, facts, news, or anything that might not be in your training data.",
  parameters: Type.Object({
    query: Type.String({ description: "The search query" }),
    topic: Type.Optional(
      Type.Union([
        Type.Literal("general"),
        Type.Literal("news"),
        Type.Literal("finance"),
      ]),
    ),
    days: Type.Optional(
      Type.Number({
        description: "Only return results from the last N days (useful for recent news)",
      }),
    ),
  }),
  async execute(_toolCallId, params, signal) {
    const response = await client.search(params.query, {
      searchDepth: "basic",
      topic: params.topic ?? "general",
      days: params.days,
      maxResults: 5,
      includeAnswer: "basic",
    });

    const results = response.results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.content}`,
      )
      .join("\n\n");

    const text = response.answer
      ? `**Answer:** ${response.answer}\n\n**Sources:**\n${results}`
      : `**Sources:**\n${results}`;

    return {
      content: [{ type: "text" as const, text }],
      details: {
        query: params.query,
        resultCount: response.results.length,
      },
    };
  },
});
