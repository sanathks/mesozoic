/**
 * Guardrails — configurable bash command classification.
 *
 * Modes:
 *   off        — no checks, everything allowed
 *   permissive — only block catastrophic commands (rm -rf /, fork bombs, etc.)
 *   standard   — block dangerous + use safe whitelist, model for unknowns (default)
 *   strict     — block anything not in the safe whitelist, model for unknowns
 *
 * Config files (merged, local overrides project):
 *   Project: guardrails.json (in repo root)
 *   Local:   ~/.meso/agents/{id}/guardrails.local.json
 */

import fs from "node:fs";
import path from "node:path";
import { complete, type UserMessage } from "@mariozechner/pi-ai";
import { createAuthStorage, createModelRegistry } from "./config.js";
import { loadRuntimeConfig, resolveSideModelEndpoint } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GuardrailMode = "off" | "permissive" | "standard" | "strict";

interface GuardrailsConfig {
  mode: GuardrailMode;
  blockedCommands: string[];
  blockedPatterns: string[];
  allowedCommands: string[];
  allowedPatterns: string[];
  allowedPaths: string[];
  blockedPathPatterns: string[];
  allowedNpmInstalls: string[];
}

export interface GuardrailResult {
  blocked: boolean;
  reason?: string;
  tier?: "blocklist" | "whitelist" | "allowlist" | "model";
  risk?: RiskLevel;
}

type RiskLevel = "safe" | "moderate" | "dangerous" | "error";

// ─── Config Loading ──────────────────────────────────────────────────────────

function getProjectConfigPath(): string {
  return process.env.MESO_GUARDRAILS_PROJECT_CONFIG || path.join(process.cwd(), "guardrails.json");
}

function getLocalConfigPath(): string {
  return process.env.MESO_GUARDRAILS_LOCAL_CONFIG || path.join(process.env.HOME || "", ".meso", "runtime", "guardrails.local.json");
}

let _config: GuardrailsConfig | null = null;
let _configKey = "";

function mergeUnique(a: string[] = [], b: string[] = []): string[] {
  return Array.from(new Set([...(a || []), ...(b || [])]));
}

function getMtimeOrZero(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function loadConfig(): GuardrailsConfig {
  const projectPath = getProjectConfigPath();
  const localPath = getLocalConfigPath();
  const projectMtime = getMtimeOrZero(projectPath);
  const localMtime = getMtimeOrZero(localPath);
  const key = `${projectMtime}:${localMtime}`;
  if (_config && key === _configKey) return _config;

  let project: Partial<GuardrailsConfig> = {};
  try { project = JSON.parse(fs.readFileSync(projectPath, "utf-8")); } catch {}

  let local: Partial<GuardrailsConfig> = {};
  try { local = JSON.parse(fs.readFileSync(localPath, "utf-8")); } catch {}

  // If local config has a mode field, the user owns the config — use it as primary.
  // Project config only fills in fields the user hasn't set.
  const userOwned = local.mode !== undefined;

  if (userOwned) {
    _config = {
      mode: local.mode as GuardrailMode,
      blockedCommands: local.blockedCommands ?? project.blockedCommands ?? [],
      blockedPatterns: local.blockedPatterns ?? project.blockedPatterns ?? [],
      allowedCommands: local.allowedCommands ?? project.allowedCommands ?? [],
      allowedPatterns: local.allowedPatterns ?? project.allowedPatterns ?? [],
      allowedPaths: local.allowedPaths ?? project.allowedPaths ?? [],
      blockedPathPatterns: local.blockedPathPatterns ?? project.blockedPathPatterns ?? [],
      allowedNpmInstalls: local.allowedNpmInstalls ?? project.allowedNpmInstalls ?? [],
    };
  } else {
    // No local override — merge both (backwards compatible)
    _config = {
      mode: (project.mode || "standard") as GuardrailMode,
      blockedCommands: mergeUnique(project.blockedCommands, local.blockedCommands),
      blockedPatterns: mergeUnique(project.blockedPatterns, local.blockedPatterns),
      allowedCommands: mergeUnique(project.allowedCommands, local.allowedCommands),
      allowedPatterns: mergeUnique(project.allowedPatterns, local.allowedPatterns),
      allowedPaths: mergeUnique(project.allowedPaths, local.allowedPaths),
      blockedPathPatterns: mergeUnique(project.blockedPathPatterns, local.blockedPathPatterns),
      allowedNpmInstalls: mergeUnique(project.allowedNpmInstalls, local.allowedNpmInstalls),
    };
  }

  _configKey = key;
  return _config;
}

// ─── Catastrophic blocklist (always active, even in permissive) ──────────────

const CATASTROPHIC_PATTERNS: RegExp[] = [
  /^rm\s+-rf\s+[/~]/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,  // fork bomb
  /^mkfs\b/,
  /^dd\s+if=/,
  />\s*\/dev\/[sh]d/,
  /^chmod\s+-R\s+777\s+\//,
  /^(shutdown|reboot|halt|init\s+[06])\b/,
  /curl\s+.*\|\s*(bash|sh)\b/,
  /wget\s+.*\|\s*(bash|sh)\b/,
];

// Commands that read secrets — blocked in standard/strict modes
const SECRET_READ_PATTERNS: RegExp[] = [
  /\b(cat|head|tail|less|more|bat)\s+[^\s]*\.env\b/,
  /\b(cat|head|tail|less|more|bat)\s+[^\s]*\.env\.[^\s]+/,
  /\bsource\s+[^\s]*\.env\b/,
  /\b\.\s+[^\s]*\.env\b/,
  /\bgrep\s+.*\.env\b/,
  /\becho\s+\$([\w_]*KEY|[\w_]*SECRET|[\w_]*TOKEN|[\w_]*PASSWORD)\b/i,
  /\bprintenv\s+([\w_]*KEY|[\w_]*SECRET|[\w_]*TOKEN|[\w_]*PASSWORD)\b/i,
];

function isCatastrophic(cmd: string): boolean {
  return CATASTROPHIC_PATTERNS.some((re) => re.test(cmd));
}

// ─── Safe whitelist (tier 2) ─────────────────────────────────────────────────

const SAFE_PATTERNS: RegExp[] = [
  // filesystem reads
  /^(cd|pwd)\b/,
  /^(ls|ll|la|l)\b/,
  /^cat\s+(?!\/(?:etc|root|var|usr|sys|proc|dev|private|boot)\/)\S/,
  /^(head|tail|less|more|wc|file|stat|du|tree)\s/,
  /^df\b/,
  /^(realpath|basename|dirname|readlink)\s+/,
  /^(fd|find)\s/,
  // search
  /^(grep|rg|ag|ack)\s/,
  /^git\s+grep\b/,
  // git read-only
  /^git\s+(log|diff|show|status|branch|tag|remote|describe|shortlog|rev-parse|ls-files|reflog|blame|stash\s+(list|show))\b/,
  // git write (common safe operations)
  /^git\s+(add|commit|checkout|switch|merge|rebase|pull|fetch|stash\s+(push|pop|apply|drop))\b/,
  // process / system info
  /^(ps|top|htop|uptime|uname|whoami|hostname|date)\b/,
  /^env\b$/,
  /^(command\s+-v|which|type)\s/,
  // version checks
  /^(node|npm|npx|python|python3|ruby|go|cargo|rustc|bun|deno|git)\s+(--version|-v)\b/,
  // script execution
  /^(bun|node|npx\s+tsx)\s+[^|;&]+\.([jt]s|mjs|cjs)\b/,
  // package managers (read)
  /^(npm\s+ls|npm\s+view|npm\s+outdated|npm\s+audit)\b/,
  // reading config files
  /^cat\s+(package\.json|tsconfig\.json|\.env\.example|package-lock\.json)\s*$/,
  /^jq\s+/,
  // echo/printf (output only)
  /^(echo|printf)\s/,
  // mkdir, touch, cp (basic file ops)
  /^(mkdir|touch|cp)\s/,
  // sed, awk (text processing)
  /^(sed|awk)\s/,
];

const MODERATE_PATTERNS: RegExp[] = [
  // build / test
  /^(npm\s+(run|test|start|build)|npx\s+tsx)\b/,
  /^(bun\s+(build|test)|tsc|eslint|prettier|vitest)\b/,
  // npm install (scoped)
  /^npm\s+install\b/,
  // git push
  /^git\s+push\b/,
  // network reads
  /^curl\s+(?!.*\|\s*(bash|sh)).*https?:\/\//i,
  /^wget\s+-qO-\s+/i,
  // docker (non-destructive)
  /^docker\s+(ps|images|logs|inspect)\b/,
];

function stripSafeCommandPrelude(cmd: string): string {
  let current = cmd.trim();
  while (true) {
    const next = current.match(/^cd\s+(?:"[^"]+"|'[^']+'|[^;&|]+?)\s*(?:&&|;)\s*(.+)$/s);
    if (!next) break;
    current = next[1].trim();
  }
  return current;
}

function isSafeByWhitelist(cmd: string): boolean {
  const normalized = stripSafeCommandPrelude(cmd);
  return SAFE_PATTERNS.some((re) => re.test(normalized));
}

function isModerateByWhitelist(cmd: string): boolean {
  const normalized = stripSafeCommandPrelude(cmd);
  return MODERATE_PATTERNS.some((re) => re.test(normalized));
}

function usesHeredoc(cmd: string): boolean {
  return /<<[-~]?\s*['"]?[A-Za-z0-9_]+['"]?/.test(cmd);
}

// ─── User-defined allowlist ──────────────────────────────────────────────────

function isUserAllowed(cmd: string, config: GuardrailsConfig): boolean {
  for (const allowed of config.allowedCommands) {
    if (cmd.startsWith(allowed)) return true;
  }
  for (const pattern of config.allowedPatterns) {
    if (new RegExp(pattern, "i").test(cmd)) return true;
  }
  return false;
}

// ─── Tier 3: side model ──────────────────────────────────────────────────────

const MODEL_SYSTEM = `You are a security guardrail for an AI coding assistant that executes shell commands on a developer's machine.

Classify the command as one of:
- "safe"      — read-only, no side effects, cannot harm the system
- "moderate"  — writes files or makes network requests, but scoped and reversible
- "dangerous" — destructive, irreversible, privilege escalation, data exfiltration, or system modification

Pay special attention to:
- Commands that leak environment variables or secrets (e.g. echo $API_KEY, env | curl)
- Pipes that execute remote code (curl | bash)
- Force-pushes, disk writes to system paths, privilege escalation

Respond with ONLY valid JSON: {"risk": "safe"|"moderate"|"dangerous", "reason": "one sentence"}`;

function parseGuardrailResponse(raw: string): { risk: RiskLevel; reason: string } {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error("No JSON in response");
  return JSON.parse(match[0]) as { risk: RiskLevel; reason: string };
}

async function classifyWithOllama(command: string): Promise<{ risk: RiskLevel; reason: string }> {
  const { baseUrl, modelId, apiKey } = resolveSideModelEndpoint(loadRuntimeConfig());
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: MODEL_SYSTEM },
        { role: "user", content: `Command: ${command}` },
      ],
      temperature: 0,
      max_tokens: 80,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as any;
  return parseGuardrailResponse(data.choices?.[0]?.message?.content ?? "");
}

async function classifyWithPiAuth(command: string): Promise<{ risk: RiskLevel; reason: string }> {
  const config = loadRuntimeConfig();
  const authStorage = createAuthStorage();
  const modelRegistry = createModelRegistry(authStorage);
  const model = modelRegistry.find(config.sideModel.provider, config.sideModel.id);
  if (!model) throw new Error(`Model not found: ${config.sideModel.provider}/${config.sideModel.id}`);

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey && model.provider !== "ollama") {
    throw new Error(`No API key available for ${model.provider}/${model.id}`);
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: `Command: ${command}` }],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: MODEL_SYSTEM, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 80, signal: AbortSignal.timeout(10_000) },
  );

  const raw = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return parseGuardrailResponse(raw);
}

async function classifyWithModel(command: string): Promise<{ risk: RiskLevel; reason: string }> {
  const runtimeConfig = loadRuntimeConfig();
  try {
    if (runtimeConfig.sideModel.provider === "ollama") return await classifyWithOllama(command);
    return await classifyWithPiAuth(command);
  } catch (err) {
    console.error("[guardrails] model classification failed, failing open:", err);
    return { risk: "moderate", reason: `Model unavailable: ${err}` };
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function checkBashCommand(command: string): Promise<GuardrailResult> {
  const config = loadConfig();
  const cmd = command.trim();

  // Off mode — everything allowed
  if (config.mode === "off") {
    return { blocked: false, tier: "whitelist", risk: "safe" };
  }

  // ── Always block catastrophic commands (all modes except off) ───────────
  if (isCatastrophic(cmd)) {
    console.log(`[guardrails] catastrophic block: "${cmd.slice(0, 80)}"`);
    return { blocked: true, reason: "Catastrophic command blocked", tier: "blocklist" };
  }

  // ── Block secret/env file reads (all modes except off) ─────────────────
  if (SECRET_READ_PATTERNS.some((re) => re.test(cmd))) {
    console.log(`[guardrails] secret read block: "${cmd.slice(0, 80)}"`);
    return { blocked: true, reason: "Reading secrets/env files is blocked", tier: "blocklist" };
  }

  // ── User-defined allowlist (overrides blocklist) ───────────────────────
  if (isUserAllowed(cmd, config)) {
    return { blocked: false, tier: "allowlist", risk: "moderate" };
  }

  // Permissive mode — only catastrophic + secret reads blocked (handled above)
  if (config.mode === "permissive") {
    return { blocked: false, tier: "whitelist", risk: "moderate" };
  }

  // ── Tier 1: blocklist ──────────────────────────────────────────────────
  for (const blocked of config.blockedCommands) {
    if (cmd.includes(blocked)) {
      console.log(`[guardrails] tier1 block: "${blocked}"`);
      return { blocked: true, reason: `Blocked command: "${blocked}"`, tier: "blocklist" };
    }
  }

  for (const pattern of config.blockedPatterns) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(cmd)) {
      // npm install exception
      if (pattern.includes("npm install")) {
        const match = cmd.match(/npm install\s+(?:-[^\s]+\s+)*(.+)/i);
        if (match) {
          const pkgs = match[1].split(/\s+/);
          const allAllowed = pkgs.every((pkg) =>
            config.allowedNpmInstalls.some((a) => pkg === a || pkg.startsWith(a + "@")),
          );
          if (allAllowed) continue;
        }
      }
      console.log(`[guardrails] tier1 block pattern: "${pattern}"`);
      return { blocked: true, reason: `Blocked pattern: "${pattern}"`, tier: "blocklist" };
    }
  }

  // ── Tier 2: safe/moderate whitelist ────────────────────────────────────
  if (/^cd\s+(?:"[^"]+"|'[^']+'|[^;&|]+?)\s*$/.test(cmd) || cmd === "cd") {
    return { blocked: false, tier: "whitelist", risk: "safe" };
  }

  if (isSafeByWhitelist(cmd)) {
    return { blocked: false, tier: "whitelist", risk: "safe" };
  }

  if (isModerateByWhitelist(cmd)) {
    return { blocked: false, tier: "whitelist", risk: "moderate" };
  }

  if (usesHeredoc(cmd)) {
    return { blocked: false, tier: "whitelist", risk: "moderate" };
  }

  // ── Standard mode: pass unknown commands through (no model call) ───────
  // Model calls add latency and false positives. Standard mode trusts the
  // agent for commands not in the blocklist or whitelist.
  if (config.mode === "standard") {
    return { blocked: false, tier: "whitelist", risk: "moderate" };
  }

  // ── Strict mode: model classification for unknowns ─────────────────────
  console.log(`[guardrails] strict model check: "${cmd.slice(0, 80)}"`);
  const { risk, reason } = await classifyWithModel(cmd);

  if (risk === "dangerous" || risk === "error") {
    console.log(`[guardrails] model block [${risk}]: ${reason}`);
    return { blocked: true, reason: `[${risk}] ${reason}`, tier: "model", risk };
  }

  return { blocked: false, tier: "model", risk };
}

/**
 * Check a file path — static only, no model needed.
 */
export function checkFilePath(filePath: string): GuardrailResult {
  const config = loadConfig();

  if (config.mode === "off" || config.mode === "permissive") {
    return { blocked: false };
  }

  const resolved = filePath.startsWith("~")
    ? filePath.replace("~", process.env.HOME || "")
    : path.resolve(filePath);

  for (const pattern of config.blockedPathPatterns) {
    const expanded = pattern.startsWith("~")
      ? pattern.replace("~", process.env.HOME || "")
      : pattern;
    if (resolved.startsWith(expanded) || resolved.includes(expanded)) {
      return { blocked: true, reason: `Blocked path: "${pattern}"` };
    }
  }

  if (config.allowedPaths.length > 0) {
    const isAllowed = config.allowedPaths.some((a) => resolved.startsWith(a));
    if (!isAllowed) {
      return { blocked: true, reason: `Path outside allowed directories: ${config.allowedPaths.join(", ")}` };
    }
  }

  return { blocked: false };
}
