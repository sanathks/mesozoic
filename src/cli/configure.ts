import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { loadAgent } from "../core/agent-loader.js";

function getEditor(): string {
  return process.env.EDITOR || process.env.VISUAL || "vi";
}

function openInEditor(filePath: string): void {
  const editor = getEditor();
  try {
    execSync(`${editor} ${JSON.stringify(filePath)}`, { stdio: "inherit" });
  } catch {}
}

function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function preview(content: string, maxLines = 5): string {
  const lines = content.trim().split("\n").filter((l) => !l.startsWith("#") && l.trim());
  return lines.slice(0, maxLines).join("\n") || "(empty)";
}

const TONE_PRESETS: Record<string, string> = {
  casual: `# Communication

- casual and friendly tone
- use emoji occasionally
- keep responses concise
- ask clarifying questions when needed`,

  professional: `# Communication

- professional and clear tone
- structured responses with headings when appropriate
- cite sources and be precise
- avoid slang and emoji`,

  technical: `# Communication

- brief and technical
- prefer code examples over explanations
- skip pleasantries, get to the point
- use precise terminology`,
};

async function editSection(label: string, filePath: string): Promise<void> {
  const current = readFile(filePath);

  p.log.info(`${label}: ${filePath}`);
  if (current.trim()) {
    p.log.message(preview(current));
  }

  const action = await p.select({
    message: `${label}`,
    options: [
      { value: "write", label: "Write in terminal", hint: "type content here" },
      { value: "editor", label: `Open in ${getEditor()}`, hint: "edit the file directly" },
      { value: "skip", label: "Keep current", hint: "no changes" },
    ],
  });

  if (p.isCancel(action)) { p.cancel("Cancelled."); process.exit(0); }

  if (action === "editor") {
    openInEditor(filePath);
    p.log.success(`Updated ${label}`);
  } else if (action === "write") {
    const content = await p.text({
      message: `Enter ${label.toLowerCase()} (multi-line: use \\n for newlines)`,
      placeholder: current.trim() || `Describe your agent's ${label.toLowerCase()}...`,
    });
    if (p.isCancel(content)) { p.cancel("Cancelled."); process.exit(0); }
    if (content) {
      // Support \n for multi-line
      const formatted = (content as string).replace(/\\n/g, "\n");
      const heading = label;
      fs.writeFileSync(filePath, `# ${heading}\n\n${formatted}\n`);
      p.log.success(`Updated ${label}`);
    }
  }
}

export async function runConfigure(agentId: string): Promise<void> {
  const agent = loadAgent(agentId);
  const root = agent.root;

  p.intro(`Configure ${agent.config.name}`);

  // 1. Identity
  const identityPath = path.join(root, agent.config.prompts.identity);
  await editSection("Identity", identityPath);

  // 2. Soul / Values
  const soulPath = path.join(root, agent.config.prompts.soul);
  await editSection("Soul", soulPath);

  // 3. Communication style
  const extraPrompts = agent.config.prompts.extra || [];
  const commsFile = extraPrompts.find((f) => f.toLowerCase().includes("comms")) || extraPrompts[0];
  if (commsFile) {
    const commsPath = path.join(root, commsFile);
    const current = readFile(commsPath);

    p.log.info(`Communication: ${commsPath}`);
    if (current.trim()) {
      p.log.message(preview(current));
    }

    const action = await p.select({
      message: "Communication style",
      options: [
        { value: "casual", label: "Casual & friendly", hint: "emoji, concise, conversational" },
        { value: "professional", label: "Professional & clear", hint: "structured, precise, formal" },
        { value: "technical", label: "Brief & technical", hint: "code-first, no fluff" },
        { value: "write", label: "Write custom", hint: "type your own" },
        { value: "editor", label: `Open in ${getEditor()}`, hint: "edit the file" },
        { value: "skip", label: "Keep current", hint: "no changes" },
      ],
    });

    if (p.isCancel(action)) { p.cancel("Cancelled."); process.exit(0); }

    if (action === "editor") {
      openInEditor(commsPath);
      p.log.success("Updated Communication");
    } else if (action === "write") {
      const content = await p.text({
        message: "Enter communication style",
        placeholder: "How should the agent communicate?",
      });
      if (!p.isCancel(content) && content) {
        const formatted = (content as string).replace(/\\n/g, "\n");
        fs.writeFileSync(commsPath, `# Communication\n\n${formatted}\n`);
        p.log.success("Updated Communication");
      }
    } else if (TONE_PRESETS[action as string]) {
      fs.writeFileSync(commsPath, TONE_PRESETS[action as string] + "\n");
      p.log.success("Updated Communication");
    }
  }

  // 4. Guardrails
  const guardrailsPath = path.join(root, agent.config.guardrails?.localConfig || "guardrails.local.json");
  let guardrailsLocal: any = {};
  try { guardrailsLocal = JSON.parse(readFile(guardrailsPath)); } catch {}

  const currentMode = guardrailsLocal.mode || "standard";
  p.log.info(`Guardrails: ${guardrailsPath} (current mode: ${currentMode})`);

  const guardMode = await p.select({
    message: "Guardrails mode",
    initialValue: currentMode,
    options: [
      { value: "off", label: "Off", hint: "no restrictions — agent can run anything" },
      { value: "permissive", label: "Permissive", hint: "only block catastrophic commands (rm -rf /, fork bombs)" },
      { value: "standard", label: "Standard", hint: "blocklist + safe whitelist, no model calls (recommended)" },
      { value: "strict", label: "Strict", hint: "unknown commands checked by side model before running" },
      { value: "skip", label: "Keep current", hint: `currently: ${currentMode}` },
    ],
  });

  if (!p.isCancel(guardMode) && guardMode !== "skip") {
    // Scaffold full config so user can override everything
    const defaults = {
      mode: guardMode,
      blockedCommands: guardrailsLocal.blockedCommands ?? [
        "rm -rf /",
        "rm -rf ~",
        "rm -rf /*",
        "mkfs",
        "dd if=",
        "> /dev/sda",
        "chmod -R 777 /",
        ":(){ :|:& };:",
      ],
      blockedPatterns: guardrailsLocal.blockedPatterns ?? [
        "curl .* [|] (bash|sh)",
        "wget .* [|] (bash|sh)",
        "sudo .*",
        "su -",
      ],
      allowedCommands: guardrailsLocal.allowedCommands ?? [],
      allowedPatterns: guardrailsLocal.allowedPatterns ?? [],
      allowedPaths: guardrailsLocal.allowedPaths ?? [process.cwd()],
      blockedPathPatterns: guardrailsLocal.blockedPathPatterns ?? [
        "~/.ssh",
        "~/.aws",
        "~/.gnupg",
        "~/.meso/auth.json",
        ".env",
      ],
      allowedNpmInstalls: guardrailsLocal.allowedNpmInstalls ?? [],
    };
    fs.writeFileSync(guardrailsPath, JSON.stringify(defaults, null, 2) + "\n");
    p.log.success(`Guardrails set to ${guardMode} — full config written`);
  }

  const editGuardrails = await p.confirm({ message: "Edit guardrails config?", initialValue: false });
  if (!p.isCancel(editGuardrails) && editGuardrails) {
    openInEditor(guardrailsPath);
    p.log.success("Updated guardrails config");
  }

  // 5. Agent config (name, description, behavior)
  const editConfig = await p.confirm({ message: "Edit agent config (name, description, behavior)?", initialValue: false });
  if (!p.isCancel(editConfig) && editConfig) {
    const config = JSON.parse(fs.readFileSync(path.join(root, "agent.json"), "utf-8"));

    const name = await p.text({
      message: "Display name",
      placeholder: config.name,
      defaultValue: config.name,
    });
    if (!p.isCancel(name)) config.name = name;

    const desc = await p.text({
      message: "Description",
      placeholder: config.description || "",
      defaultValue: config.description || "",
    });
    if (!p.isCancel(desc)) config.description = desc;

    const stopWord = await p.text({
      message: "Stop word (user types this to abort)",
      placeholder: config.behavior?.stopWord || "stop",
      defaultValue: config.behavior?.stopWord || "stop",
    });
    if (!p.isCancel(stopWord)) {
      if (!config.behavior) config.behavior = {};
      config.behavior.stopWord = stopWord;
    }

    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify(config, null, 2) + "\n");
    p.log.success("Updated agent.json");
  }

  // Summary
  p.note(
    [
      `Identity: ${path.join(root, agent.config.prompts.identity)}`,
      `Soul:     ${path.join(root, agent.config.prompts.soul)}`,
      ...(commsFile ? [`Comms:    ${path.join(root, commsFile)}`] : []),
      `Guards:   ${guardrailsPath}`,
      `Config:   ${path.join(root, "agent.json")}`,
      "",
      `Restart to apply: meso restart ${agentId}`,
    ].join("\n"),
    "Files",
  );

  p.outro(`${agent.config.name} configured`);
}
