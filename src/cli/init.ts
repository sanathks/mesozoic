import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";

function getRepoRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..", "..");
}

function isLocalDev(): boolean {
  // Check if we're running from a local repo (has src/ and package.json) vs global npm install
  const root = getRepoRoot();
  return fs.existsSync(path.join(root, "src")) && fs.existsSync(path.join(root, "tsup.config.ts"));
}

function which(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getVersion(cmd: string): string {
  try {
    return execSync(`${cmd} --version`, { encoding: "utf-8" }).trim().split("\n")[0];
  } catch {
    return "unknown";
  }
}

export async function runInit(): Promise<void> {
  p.intro("meso init");

  // 1. Prerequisites
  if (!which("node")) {
    p.cancel("Node.js is required. Install via: brew install node");
    process.exit(1);
  }
  p.log.success(`Node ${getVersion("node")}`);

  // 2. Build (only for local dev, not global npm install)
  if (isLocalDev()) {
    const repoRoot = getRepoRoot();
    const s = p.spinner();
    s.start("Installing dependencies...");
    execSync("npm install", { cwd: repoRoot, stdio: "ignore" });
    s.stop("Dependencies installed");

    s.start("Building...");
    execSync("npm run build", { cwd: repoRoot, stdio: "ignore" });
    s.stop("Build complete");
  }

  // 3. Create agent
  const { runNewAgentWizard } = await import("./new.js");

  const name = await p.text({ message: "Agent name", placeholder: "rex", defaultValue: "rex" });
  if (p.isCancel(name)) { p.cancel("Cancelled."); process.exit(0); }

  let agentRoot: string;
  try {
    agentRoot = await runNewAgentWizard(name);
  } catch (err) {
    if (err instanceof Error && err.message.includes("already exists")) {
      p.log.warn(`Agent '${name}' already exists, skipping creation.`);
      const { getAgentRoot } = await import("../core/storage.js");
      agentRoot = getAgentRoot(name);
    } else {
      throw err;
    }
  }

  // 4. Doctor check
  const s2 = p.spinner();
  s2.start("Running health check...");
  try {
    const { runDoctor } = await import("./doctor.js");
    runDoctor(name);
  } catch {}
  s2.stop("Health check complete");

  // 5. Done
  p.note(
    [
      `meso start ${name}              Start agent`,
      `meso status                    Show running agents`,
      `meso restart ${name}            Restart agent`,
      `meso logs ${name} -f            Tail logs`,
      `meso run ${name} --tui          Interactive mode`,
      `meso doctor ${name}              Health check`,
    ].join("\n"),
    "Next commands",
  );

  p.outro(`${name} is ready`);
}
