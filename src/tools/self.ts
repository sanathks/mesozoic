/**
 * Self-management tool — lets the agent manage its own config, models, and tools.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getDocsPath(): string {
  // Resolve from dist/ → package root → docs/agent-dev/
  const fromDist = path.resolve(__dirname, "..", "..", "docs", "agent-dev");
  if (fs.existsSync(fromDist)) return fromDist;
  // Fallback: dev mode
  return path.resolve(__dirname, "..", "docs", "agent-dev");
}

function StringEnum<T extends string>(values: readonly T[]) {
  return Type.Unsafe<T>({ type: "string", enum: values });
}

export interface SelfToolContext {
  agentId: string;
  agentRoot: string;
  configPath: string;
  reloadResources: () => Promise<void>;
  getAvailableModels: () => Promise<Array<{ provider: string; id: string }>>;
  getCurrentModel: () => string;
  switchModel: (provider: string, id: string) => Promise<boolean>;
}

let _ctx: SelfToolContext | null = null;

export function setSelfToolContext(ctx: SelfToolContext): void {
  _ctx = ctx;
}

export const selfTool = defineTool({
  name: "self",
  label: "Self Management",
  description: `Manage your own config, models, tools, and extensions.
Actions: status, reload, add-model, remove-model, switch-model, list-models, read-docs`,
  parameters: Type.Object({
    action: StringEnum([
      "status",
      "reload",
      "add-model",
      "remove-model",
      "switch-model",
      "list-models",
      "read-docs",
    ] as const),
    provider: Type.Optional(Type.String({ description: "Model provider (e.g. anthropic, openai-codex, ollama)" })),
    model_id: Type.Optional(Type.String({ description: "Model ID (e.g. claude-sonnet-4-6)" })),
    doc: Type.Optional(Type.String({ description: "Doc to read: tools, extensions, skills, models, config" })),
  }),
  async execute(_toolCallId, params) {
    if (!_ctx) {
      return { content: [{ type: "text" as const, text: "Self tool not initialized" }] };
    }

    const { action } = params;

    if (action === "status") {
      const config = JSON.parse(fs.readFileSync(_ctx.configPath, "utf-8"));
      const toolsDir = path.join(_ctx.agentRoot, "tools");
      const skillsDir = path.join(_ctx.agentRoot, "skills");

      const tools = fs.existsSync(toolsDir)
        ? fs.readdirSync(toolsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
        : [];
      const skills = fs.existsSync(skillsDir)
        ? fs.readdirSync(skillsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")))
            .map((d) => d.name)
        : [];

      const status = [
        `Agent: ${config.name} (${_ctx.agentId})`,
        `Current model: ${_ctx.getCurrentModel()}`,
        ``,
        `Models (fallback chain):`,
        ...config.models.main.map((m: any, i: number) => `  ${i + 1}. ${m.provider}/${m.id}`),
        `Side model: ${config.models.side.provider}/${config.models.side.id}`,
        ``,
        `Custom tools: ${tools.length > 0 ? tools.join(", ") : "none"}`,
        `Skills: ${skills.length > 0 ? skills.join(", ") : "none"}`,
        ``,
        `Paths:`,
        `  Config: ${_ctx.configPath}`,
        `  Tools: ${toolsDir}`,
        `  Skills: ${skillsDir}`,
        `  Docs: ${getDocsPath()}`,
      ];

      return { content: [{ type: "text" as const, text: status.join("\n") }] };
    }

    if (action === "reload") {
      try {
        await _ctx.reloadResources();
        return { content: [{ type: "text" as const, text: "Resources reloaded. New tools and extensions are now available." }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Reload failed: ${err instanceof Error ? err.message : err}` }] };
      }
    }

    if (action === "add-model") {
      if (!params.provider || !params.model_id) {
        return { content: [{ type: "text" as const, text: "Provide provider and model_id" }] };
      }
      const config = JSON.parse(fs.readFileSync(_ctx.configPath, "utf-8"));
      const exists = config.models.main.some((m: any) => m.provider === params.provider && m.id === params.model_id);
      if (exists) {
        return { content: [{ type: "text" as const, text: `${params.provider}/${params.model_id} already in model list` }] };
      }
      config.models.main.push({ provider: params.provider, id: params.model_id });
      fs.writeFileSync(_ctx.configPath, JSON.stringify(config, null, 2) + "\n");
      return { content: [{ type: "text" as const, text: `Added ${params.provider}/${params.model_id} to model list (position ${config.models.main.length}). Takes effect on next session or after restart.` }] };
    }

    if (action === "remove-model") {
      if (!params.provider || !params.model_id) {
        return { content: [{ type: "text" as const, text: "Provide provider and model_id" }] };
      }
      const config = JSON.parse(fs.readFileSync(_ctx.configPath, "utf-8"));
      const idx = config.models.main.findIndex((m: any) => m.provider === params.provider && m.id === params.model_id);
      if (idx === -1) {
        return { content: [{ type: "text" as const, text: `${params.provider}/${params.model_id} not found in model list` }] };
      }
      if (config.models.main.length <= 1) {
        return { content: [{ type: "text" as const, text: "Cannot remove the last model" }] };
      }
      config.models.main.splice(idx, 1);
      fs.writeFileSync(_ctx.configPath, JSON.stringify(config, null, 2) + "\n");
      return { content: [{ type: "text" as const, text: `Removed ${params.provider}/${params.model_id} from model list` }] };
    }

    if (action === "switch-model") {
      if (!params.provider || !params.model_id) {
        return { content: [{ type: "text" as const, text: "Provide provider and model_id" }] };
      }
      const ok = await _ctx.switchModel(params.provider, params.model_id);
      if (ok) {
        return { content: [{ type: "text" as const, text: `Switched to ${params.provider}/${params.model_id}` }] };
      }
      return { content: [{ type: "text" as const, text: `Failed to switch to ${params.provider}/${params.model_id}` }] };
    }

    if (action === "list-models") {
      try {
        const available = await _ctx.getAvailableModels();
        if (available.length === 0) {
          return { content: [{ type: "text" as const, text: "No models available. Run: meso login" }] };
        }
        const lines = available.map((m) => `  ${m.provider}/${m.id}`);
        return { content: [{ type: "text" as const, text: `Available models:\n${lines.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to list models: ${err instanceof Error ? err.message : err}` }] };
      }
    }

    if (action === "read-docs") {
      const docName = params.doc || "tools";
      const docsPath = getDocsPath();
      const docFile = path.join(docsPath, `${docName}.md`);
      if (!fs.existsSync(docFile)) {
        const available = fs.existsSync(docsPath)
          ? fs.readdirSync(docsPath).filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", ""))
          : [];
        return { content: [{ type: "text" as const, text: `Doc "${docName}" not found. Available: ${available.join(", ")}` }] };
      }
      const content = fs.readFileSync(docFile, "utf-8");
      return { content: [{ type: "text" as const, text: content }] };
    }

    return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
  },
});
