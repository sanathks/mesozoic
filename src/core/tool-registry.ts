import { memoryTool } from "../tools/memory.js";
import { searchTool } from "../tools/search.js";

const TOOL_REGISTRY: Record<string, any> = {
  memory: memoryTool,
  search: searchTool,
  web_search: searchTool,
};

export function resolveTools(toolNames: string[] = []): any[] {
  return toolNames
    .map((name) => TOOL_REGISTRY[name])
    .filter(Boolean)
    .filter((tool, index, arr) => arr.indexOf(tool) === index)
    .filter((tool) => tool !== searchTool || !!process.env.TAVILY_API_KEY);
}
