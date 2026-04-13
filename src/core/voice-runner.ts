/**
 * Voice Runner — real-time voice conversation with an agent.
 *
 * Spawns a Python voice bridge subprocess that handles:
 *   Mic → VAD → STT (Moonshine) → transcript
 *   Text → TTS (Kokoro) → Speaker
 *
 * This runner handles agent interaction:
 *   transcript → runtime.prompt() → stream response → bridge TTS
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { loadAgent } from "./agent-loader.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import { MESO_DIR } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VOICE_DIR = path.join(MESO_DIR, "voice");
const VENV_DIR = path.join(VOICE_DIR, "venv");
const BRIDGE_SCRIPT = path.join(VOICE_DIR, "bridge.py");

// ─── Voice Environment Setup ────────────────────────────────────────────────

function getPythonBin(): string | null {
  for (const cmd of ["python3.11", "python3.12", "python3.13", "python3"]) {
    try {
      const version = execSync(`${cmd} --version 2>/dev/null`, { encoding: "utf-8", shell: true }).trim();
      const match = version.match(/(\d+)\.(\d+)/);
      if (match && parseInt(match[1]) >= 3 && parseInt(match[2]) >= 11) {
        return cmd;
      }
    } catch {}
  }
  return null;
}

function isVoiceSetup(): boolean {
  const venvPython = path.join(VENV_DIR, "bin", "python");
  return fs.existsSync(venvPython) && fs.existsSync(BRIDGE_SCRIPT);
}

function getBundledBridgePath(): string {
  // Bridge script is bundled in the npm package at voice/bridge.py
  // relative to dist/ → ../voice/bridge.py
  const fromDist = path.resolve(__dirname, "..", "..", "voice", "bridge.py");
  if (fs.existsSync(fromDist)) return fromDist;
  // Dev mode: same repo
  const fromSrc = path.resolve(__dirname, "..", "..", "voice", "bridge.py");
  return fromSrc;
}

function getBundledRequirements(): string {
  const fromDist = path.resolve(__dirname, "..", "..", "voice", "requirements.txt");
  if (fs.existsSync(fromDist)) return fromDist;
  return path.resolve(__dirname, "..", "..", "voice", "requirements.txt");
}

export async function setupVoice(): Promise<void> {
  const python = getPythonBin();
  if (!python) {
    throw new Error("Python 3.11+ is required for voice mode. Install via: brew install python@3.11");
  }
  console.log(`  Using ${python}`);

  // Create voice directory
  fs.mkdirSync(VOICE_DIR, { recursive: true });

  // Copy bridge script
  const bundledBridge = getBundledBridgePath();
  if (!fs.existsSync(bundledBridge)) {
    throw new Error(`Voice bridge not found at ${bundledBridge}`);
  }
  fs.copyFileSync(bundledBridge, BRIDGE_SCRIPT);

  // Copy requirements
  const bundledReqs = getBundledRequirements();
  const targetReqs = path.join(VOICE_DIR, "requirements.txt");
  if (fs.existsSync(bundledReqs)) {
    fs.copyFileSync(bundledReqs, targetReqs);
  }

  // Create venv
  if (!fs.existsSync(VENV_DIR)) {
    console.log("  Creating Python environment...");
    execSync(`${python} -m venv ${VENV_DIR}`, { stdio: "inherit" });
  }

  // Install deps
  const pip = path.join(VENV_DIR, "bin", "pip");
  console.log("  Installing voice dependencies...");
  execSync(`${pip} install -r ${targetReqs}`, { stdio: "inherit" });

  // Check system deps
  const platform = process.platform;
  if (platform === "darwin") {
    try {
      execSync("brew list portaudio", { stdio: "ignore" });
    } catch {
      console.log("\n  portaudio is required. Installing via Homebrew...");
      execSync("brew install portaudio", { stdio: "inherit" });
    }
  }

  console.log("  Voice mode ready.");
}

// ─── Voice Bridge Process ───────────────────────────────────────────────────

interface BridgeMessage {
  type: "ready" | "listening" | "transcript" | "interrupt" | "error" | "status" | "stopped";
  text?: string;
  message?: string;
}

interface VoiceConfig {
  inputDevice?: number | null;
  outputDevice?: number | null;
  ttsVoice?: string;
  silenceThreshold?: number;
}

function loadVoiceConfig(): VoiceConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(VOICE_DIR, "config.json"), "utf-8"));
  } catch {
    return {};
  }
}

function spawnBridge(): ChildProcess {
  // Always sync latest bridge script
  const bundledBridge = getBundledBridgePath();
  if (fs.existsSync(bundledBridge)) {
    fs.copyFileSync(bundledBridge, BRIDGE_SCRIPT);
  }

  const pythonBin = path.join(VENV_DIR, "bin", "python");
  const config = loadVoiceConfig();

  // Pass config as env vars to the bridge
  const env: Record<string, string> = { ...process.env };
  if (config.inputDevice != null) env.MESO_VOICE_INPUT_DEVICE = String(config.inputDevice);
  if (config.outputDevice != null) env.MESO_VOICE_OUTPUT_DEVICE = String(config.outputDevice);
  if (config.ttsVoice) env.MESO_VOICE_TTS_VOICE = config.ttsVoice;
  if (config.silenceThreshold) env.MESO_VOICE_SILENCE_THRESHOLD = String(config.silenceThreshold);

  return spawn(pythonBin, [BRIDGE_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
}

function sendToBridge(bridge: ChildProcess, msg: object): void {
  bridge.stdin?.write(JSON.stringify(msg) + "\n");
}

// ─── Voice Runner ───────────────────────────────────────────────────────────

export async function runVoiceAgent(agentId: string): Promise<void> {
  // Check setup
  if (!isVoiceSetup()) {
    console.log("\n  Setting up voice mode...");
    await setupVoice();
  }

  const agent = loadAgent(agentId);
  console.log(`\n  ${agent.config.name} — voice mode`);
  console.log("  Loading...\n");

  // Suppress noisy runtime/extraction logs in voice mode
  process.env.MESO_QUIET = "1";

  const runtime = await createAgentRuntime(agentId, `voice-${Date.now()}`, "voice");

  // Spawn bridge
  const bridge = spawnBridge();
  let isProcessing = false;
  let wasInterrupted = false;

  // Handle bridge stderr (Python errors)
  bridge.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (!text) return;
    // Suppress noisy warnings from HF/torch/tokenizers
    if (text.includes("unauthenticated") || text.includes("HF_TOKEN") || text.includes("TOKENIZERS_PARALLELISM")) return;
    console.error(`  [voice] ${text}`);
  });

  // Read JSON lines from bridge stdout
  const rl = readline.createInterface({ input: bridge.stdout! });

  rl.on("line", async (line) => {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === "status") {
      console.log(`  ${msg.message}`);
    }

    if (msg.type === "ready") {
      console.log("  Ready. Listening...\n");
    }

    if (msg.type === "listening" && !isProcessing) {
      // Show listening indicator
    }

    if (msg.type === "error") {
      console.error(`  Error: ${msg.message}`);
    }

    if (msg.type === "interrupt") {
      if (isProcessing) {
        wasInterrupted = true;
        await runtime.session.abort();
        isProcessing = false;
        console.log("  [interrupted]");
      }
    }

    if (msg.type === "transcript" && msg.text) {
      // Drop transcripts while agent is still processing
      if (isProcessing) return;

      const text = msg.text;
      console.log(`  You: ${text}`);

      // Check for stop command
      if (text.toLowerCase().trim() === "stop" || text.toLowerCase().trim() === "exit") {
        console.log("\n  Stopping...");
        sendToBridge(bridge, { type: "stop" });
        return;
      }

      isProcessing = true;
      process.stdout.write(`  ${agent.config.name}: `);

      let fullResponse = "";
      wasInterrupted = false;

      const unsubscribe = runtime.session.subscribe((event: any) => {
        if (wasInterrupted) return;
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta;
          fullResponse += delta;
          process.stdout.write(delta);
        }
      });

      try {
        await runtime.prompt(text);
        unsubscribe();
        console.log("\n");

        // Send full response to TTS as one stream — Kokoro streams internally
        if (fullResponse.trim() && !wasInterrupted) {
          sendToBridge(bridge, { type: "speak_chunk", text: fullResponse.trim() });
          sendToBridge(bridge, { type: "speak_end" });
        }
      } catch (err) {
        unsubscribe();
        if (!wasInterrupted) {
          console.error(`\n  Error: ${err instanceof Error ? err.message : err}`);
        }
      } finally {
        isProcessing = false;
      }
    }
  });

  // Handle bridge exit
  bridge.on("exit", (code) => {
    if (code !== 0) {
      console.error(`\n  Voice bridge exited with code ${code}`);
    }
    process.exit(0);
  });

  // Clean shutdown
  const shutdown = () => {
    sendToBridge(bridge, { type: "stop" });
    setTimeout(() => {
      bridge.kill("SIGTERM");
      process.exit(0);
    }, 2000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
