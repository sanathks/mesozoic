import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { defineTool } from "@mariozechner/pi-coding-agent";
import {
  getMemoryDir,
  insertMemory,
  searchMemories,
  softDeleteMemory,
  getStats,
  getActiveMemories,
} from "../db/memory-db.js";

// Phrases that signal the user explicitly wants something remembered
const EXPLICIT_REMEMBER_PATTERNS = [
  /\b(remember|don'?t forget|keep in mind|make a note|note that|always remember)\b/i,
  /\b(important[: ]|pin this|save this)\b/i,
];

export function isExplicitRememberRequest(text: string): boolean {
  return EXPLICIT_REMEMBER_PATTERNS.some((re) => re.test(text));
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export function getMemoryIndexPath(): string {
  return path.join(getMemoryDir(), "MEMORY.md");
}

export function getTodayFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getMemoryDir(), `memory-${date}.md`);
}

function ensureMemoryDir(): void {
  fs.mkdirSync(getMemoryDir(), { recursive: true });
}

function readFile(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

// ─── System prompt helpers ────────────────────────────────────────────────────

/**
 * Load MEMORY.md for the system prompt.
 * Called ONCE at session creation — never reloaded so the system prompt
 * stays byte-identical every turn → prompt cache hits every call.
 */
export function loadMemoryIndex(): string {
  ensureMemoryDir();
  const content = readFile(getMemoryIndexPath()).trim();
  if (!content) return "";
  return `\n\n## Long-term Memory (MEMORY.md)\n${content}`;
}

/**
 * Load today's daily log for first-prompt injection.
 * Surfaced as a <memory:today> block prepended to the first user message —
 * NOT baked into the system prompt so it never busts the cache prefix.
 */
export function loadTodayMemories(): string {
  return readFile(getTodayFile()).trim();
}

// ─── Daily file helpers ───────────────────────────────────────────────────────

function appendTodayLog(category: string, content: string, pinned = false): void {
  ensureMemoryDir();
  const todayFile = getTodayFile();
  let existing = readFile(todayFile);

  if (!existing.trim()) {
    const date = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(todayFile, `# Memory — ${date}\n`);
  }

  const time = new Date().toTimeString().slice(0, 5);
  const pin = pinned ? " 📌" : "";
  fs.appendFileSync(todayFile, `\n## ${time} · ${category}${pin}\n${content.trim()}\n`);
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export const memoryTool = defineTool({
  name: "memory",
  label: "Memory",
  description: `Manage the agent's long-term memory stored in the active agent memory directory.

Three layers:
- MEMORY.md        — curated index, frozen into system prompt at session start
- memory.db        — SQLite: all entries with FTS5 search + importance scores
- memory-YYYY-MM-DD.md — daily append log (dream job consolidates these nightly)

Actions:
- save          → persist to SQLite (FTS-indexed, importance=1.0) + append to today's log
- search        → hybrid FTS5 + importance + recency ranking across all entries
- list          → show ALL active memories sorted by importance (no FTS, guaranteed results)
- update_index  → rewrite MEMORY.md (top ~60 lines, curated long-term facts)
- delete        → soft-delete a memory by ID (stays in DB, excluded from search)
- stats         → show DB stats (total / active / faded / avg importance)

Pinning: if the user explicitly says "remember X", "don't forget X", "keep in mind X", or similar — save with pin=true. Pinned memories NEVER decay and are always surfaced in search. They are protected from the nightly dream pruning.

IMPORTANT: Proactively save important information without being asked. When something belongs in MEMORY.md long-term, use update_index to add it.`,

  parameters: Type.Object({
    action: StringEnum(["save", "search", "list", "update_index", "delete", "stats"] as const),
    content: Type.Optional(
      Type.String({
        description:
          "save: memory text | search: query | update_index: full new MEMORY.md content",
      }),
    ),
    category: Type.Optional(
      Type.String({
        description: "preference | fact | project | person | decision | general",
      }),
    ),
    pin: Type.Optional(
      Type.Boolean({
        description:
          "Set true when the user explicitly asks to remember something (e.g. 'remember that...', 'don't forget...'). Pinned memories never decay or get pruned by the dream job.",
      }),
    ),
    id: Type.Optional(
      Type.Number({ description: "Memory ID for delete" }),
    ),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    ensureMemoryDir();

    // Extract Slack thread ID from context if available
    const sourceThread = (ctx as any)?.threadId as string | undefined;

    switch (params.action) {
      // ── save ──────────────────────────────────────────────────────────────
      case "save": {
        if (!params.content?.trim()) {
          return { content: [{ type: "text" as const, text: "Error: content is required." }] };
        }
        const category = params.category || "general";
        const pinned = params.pin === true;
        const id = insertMemory(params.content.trim(), category, sourceThread, pinned);
        appendTodayLog(category, params.content.trim(), pinned);

        const label = pinned ? " 📌 PINNED" : "";
        return {
          content: [{
            type: "text" as const,
            text: `Saved [id:${id}]${label} (${category}): ${params.content.trim()}`,
          }],
        };
      }

      // ── search ────────────────────────────────────────────────────────────
      case "search": {
        if (!params.content?.trim()) {
          return { content: [{ type: "text" as const, text: "Error: search query is required." }] };
        }

        const results = searchMemories(params.content.trim());

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: "No matching memories found." }] };
        }

        const lines = results.map((r) => {
          const age = Math.floor((Date.now() / 1000 - r.createdAt) / 86400);
          const imp = r.pinned ? "📌 pinned" : `imp=${r.importance.toFixed(2)} age=${age}d`;
          const snip = r.snippet.replace(/\n/g, " ").slice(0, 120);
          return `[id:${r.id}] (${r.category}) ${imp} — ${snip}`;
        });

        return {
          content: [{
            type: "text" as const,
            text: `Found ${results.length} memories:\n${lines.join("\n")}`,
          }],
        };
      }

      // ── update_index ──────────────────────────────────────────────────────
      case "update_index": {
        if (!params.content?.trim()) {
          return { content: [{ type: "text" as const, text: "Error: content is required." }] };
        }
        const newContent = params.content.trim();
        const lines = newContent.split("\n").length;
        fs.writeFileSync(getMemoryIndexPath(), newContent + "\n");
        return {
          content: [{
            type: "text" as const,
            text: `MEMORY.md updated (${lines} lines). Changes take effect next session.`,
          }],
        };
      }

      // ── delete ────────────────────────────────────────────────────────────
      case "delete": {
        if (!params.id) {
          return { content: [{ type: "text" as const, text: "Error: id is required." }] };
        }
        const deleted = softDeleteMemory(params.id);
        return {
          content: [{
            type: "text" as const,
            text: deleted
              ? `Deleted memory id:${params.id}.`
              : `Memory id:${params.id} not found or already deleted.`,
          }],
        };
      }

      // ── list ──────────────────────────────────────────────────────────────
      case "list": {
        const all = getActiveMemories(100);
        if (all.length === 0) {
          return { content: [{ type: "text" as const, text: "No memories stored yet." }] };
        }
        const lines = all.map((r) => {
          const age = Math.floor((Date.now() / 1000 - r.createdAt) / 86400);
          const imp = r.pinned ? "📌 pinned" : `imp=${r.importance.toFixed(2)} age=${age}d`;
          return `[id:${r.id}] (${r.category}) ${imp} — ${r.content.slice(0, 120)}`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `All memories (${all.length} total):\n${lines.join("\n")}`,
          }],
        };
      }

      // ── stats ─────────────────────────────────────────────────────────────
      case "stats": {
        const s = getStats();
        const memoryDir = getMemoryDir();
        const dailyFiles = fs.existsSync(memoryDir)
          ? fs.readdirSync(memoryDir).filter((f) => /^memory-\d{4}/.test(f)).length
          : 0;
        return {
          content: [{
            type: "text" as const,
            text: [
              `Memory DB stats:`,
              `  total entries : ${s.total}`,
              `  active        : ${s.active}`,
              `  faded/deleted : ${s.faded}`,
              `  avg importance: ${s.avgImportance}`,
              `  daily log files: ${dailyFiles}`,
            ].join("\n"),
          }],
        };
      }

      default:
        return { content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }] };
    }
  },
});
