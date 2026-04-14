import { memoryTool } from "../tools/memory.js";
import { searchTool } from "../tools/search.js";
import { selfTool } from "../tools/self.js";

const TOOL_REGISTRY: Record<string, any> = {
  memory: memoryTool,
  search: searchTool,
  web_search: searchTool,
  self: selfTool,
};

export function resolveTools(toolNames: string[] = []): any[] {
  // Always include 'self' tool
  const names = [...new Set([...toolNames, "self"])];
  return names
    .map((name) => TOOL_REGISTRY[name])
    .filter(Boolean)
    .filter((tool, index, arr) => arr.indexOf(tool) === index)
    .filter((tool) => tool !== searchTool || !!process.env.TAVILY_API_KEY);
}
