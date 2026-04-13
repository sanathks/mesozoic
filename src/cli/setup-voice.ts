/**
 * Voice mode setup wizard.
 *
 * Handles: Python env, dependencies, model download, mic/speaker selection.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { MESO_DIR } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VOICE_DIR = path.join(MESO_DIR, "voice");
const VENV_DIR = path.join(VOICE_DIR, "venv");
const CONFIG_FILE = path.join(VOICE_DIR, "config.json");

interface VoiceConfig {
  inputDevice?: number | null;
  outputDevice?: number | null;
  inputDeviceName?: string;
  outputDeviceName?: string;
  sttModel?: string;
  ttsVoice?: string;
  silenceThreshold?: number;
}

function loadConfig(): VoiceConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config: VoiceConfig): void {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

function getPythonBin(): string | null {
  for (const cmd of ["python3.11", "python3.12", "python3.13", "python3"]) {
    try {
      const version = execSync(`${cmd} --version`, { encoding: "utf-8" }).trim();
      const match = version.match(/(\d+)\.(\d+)/);
      if (match && parseInt(match[1]) >= 3 && parseInt(match[2]) >= 11) return cmd;
    } catch {}
  }
  return null;
}

function getVenvPython(): string {
  return path.join(VENV_DIR, "bin", "python");
}

function listAudioDevices(): Array<{ index: number; name: string; inputs: number; outputs: number }> {
  const venvPython = getVenvPython();
  if (!fs.existsSync(venvPython)) return [];
  try {
    const scriptFile = path.join(VOICE_DIR, "_list_devices.py");
    fs.writeFileSync(scriptFile, `import sounddevice as sd, json
devices = sd.query_devices()
result = []
for i, d in enumerate(devices):
    result.append({"index": i, "name": d["name"], "inputs": d["max_input_channels"], "outputs": d["max_output_channels"]})
print(json.dumps(result))
`);
    const output = execSync(`${venvPython} ${scriptFile}`, {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    fs.unlinkSync(scriptFile);
    return JSON.parse(output);
  } catch {
    return [];
  }
}

export async function runSetupVoice(): Promise<void> {
  p.intro("Voice mode setup");

  // 1. Python check
  let python = getPythonBin();
  if (!python) {
    const currentVersion = (() => {
      try { return execSync("python3 --version", { encoding: "utf-8" }).trim(); } catch { return "not found"; }
    })();
    p.log.warn(`Python 3.11+ required (found: ${currentVersion})`);

    if (process.platform === "darwin") {
      const install = await p.confirm({ message: "Install Python 3.13 via Homebrew?", initialValue: true });
      if (p.isCancel(install) || !install) {
        p.cancel("Python 3.11+ is required. Install manually: brew install python@3.13");
        process.exit(1);
      }
      const s0 = p.spinner();
      s0.start("Installing Python 3.13...");
      execSync("brew install python@3.13", { stdio: "inherit" });
      s0.stop("Python 3.13 installed");
      python = getPythonBin();
    } else {
      p.cancel("Python 3.11+ is required. Install via your package manager (e.g. apt install python3.13)");
      process.exit(1);
    }

    if (!python) {
      p.cancel("Python 3.11+ still not found after install. Check your PATH.");
      process.exit(1);
    }
  }
  const version = execSync(`${python} --version`, { encoding: "utf-8" }).trim();
  p.log.success(`${version}`);

  // 2. System dependencies
  if (process.platform === "darwin") {
    const s = p.spinner();
    s.start("Checking system dependencies...");
    let needsBrew = false;
    try { execSync("brew list portaudio", { stdio: "ignore" }); } catch { needsBrew = true; }

    if (needsBrew) {
      s.stop("Installing portaudio...");
      execSync("brew install portaudio", { stdio: "inherit" });
    }

    try { execSync("brew list espeak-ng", { stdio: "ignore" }); } catch {
      execSync("brew install espeak-ng", { stdio: "inherit" });
    }
    s.stop("System dependencies ready");
  } else if (process.platform === "linux") {
    p.log.info("Ensure these are installed: portaudio19-dev espeak-ng");
    p.log.info("  sudo apt install portaudio19-dev espeak-ng");
  }

  // 3. Python venv + deps
  const s = p.spinner();
  fs.mkdirSync(VOICE_DIR, { recursive: true });

  if (!fs.existsSync(VENV_DIR)) {
    s.start("Creating Python environment...");
    execSync(`${python} -m venv ${VENV_DIR}`, { stdio: "ignore" });
    s.stop("Python environment created");
  } else {
    p.log.success("Python environment exists");
  }

  const pip = path.join(VENV_DIR, "bin", "pip");
  const reqs = path.resolve(__dirname, "..", "..", "voice", "requirements.txt");
  const localReqs = path.join(VOICE_DIR, "requirements.txt");
  if (fs.existsSync(reqs)) fs.copyFileSync(reqs, localReqs);

  s.start("Installing voice dependencies...");
  try {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync(pip, ["install", "-r", localReqs], {
      encoding: "utf-8",
      timeout: 600000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Count installed vs already-satisfied
    const lines = output.split("\n").filter(Boolean);
    const installed = lines.filter((l) => l.startsWith("Collecting") || l.startsWith("Installing")).length;
    const satisfied = lines.filter((l) => l.includes("already satisfied")).length;
    if (installed > 0) {
      s.stop(`Voice dependencies installed (${installed} new packages)`);
    } else {
      s.stop(`Voice dependencies ready (${satisfied} packages)`);
    }
  } catch (err: any) {
    const stderr = err?.stderr?.toString() || "";
    s.stop("Dependency install failed");
    if (stderr) p.log.error(stderr.slice(-200));
    throw err;
  }

  // Copy bridge script
  const bridgeSrc = path.resolve(__dirname, "..", "..", "voice", "bridge.py");
  const bridgeDest = path.join(VOICE_DIR, "bridge.py");
  if (fs.existsSync(bridgeSrc)) fs.copyFileSync(bridgeSrc, bridgeDest);

  // 4. Download models (one at a time with visible progress)
  const venvPy = getVenvPython();

  const modelsDir = path.join(VOICE_DIR, "models");
  fs.mkdirSync(modelsDir, { recursive: true });

  function runPyScript(label: string, script: string, timeout: number): void {
    const scriptFile = path.join(VOICE_DIR, "_download.py");
    fs.writeFileSync(scriptFile, script);
    s.start(`Downloading ${label}...`);
    try {
      execSync(`${venvPy} ${scriptFile}`, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
      });
      s.stop(`${label} ready`);
    } catch (err: any) {
      const stderr = err?.stderr?.toString().slice(-200) || "";
      s.stop(`${label} — failed`);
      if (stderr) p.log.warn(stderr);
    }
    try { fs.unlinkSync(scriptFile); } catch {}
  }

  runPyScript("VAD model (Silero)", `import torch
torch.hub.load('snakers4/silero-vad', 'silero_vad', trust_repo=True)
`, 120000);

  runPyScript("STT model (Moonshine Base)", `from moonshine_onnx import MoonshineOnnxModel
MoonshineOnnxModel(model_name='moonshine/base')
`, 180000);

  runPyScript("TTS model (Kokoro, ~350MB)", `import urllib.request, os
d = '${modelsDir}'
m = os.path.join(d, 'kokoro-v1.0.onnx')
v = os.path.join(d, 'voices-v1.0.bin')
if not os.path.exists(m):
    urllib.request.urlretrieve('https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx', m)
if not os.path.exists(v):
    urllib.request.urlretrieve('https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin', v)
from kokoro_onnx import Kokoro
Kokoro(m, v)
`, 600000);

  runPyScript("Smart Turn v3 (turn detection)", `import os, urllib.request, tempfile
model_dir = os.path.join(tempfile.gettempdir(), 'smart_turn_v3')
model_path = os.path.join(model_dir, 'smart_turn_v3.2_cpu.onnx')
if not os.path.exists(model_path):
    os.makedirs(model_dir, exist_ok=True)
    urllib.request.urlretrieve(
        'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx',
        model_path)
# Also warm up the Whisper feature extractor (downloads tokenizer on first run)
from transformers import WhisperFeatureExtractor
WhisperFeatureExtractor.from_pretrained('openai/whisper-tiny')
`, 180000);

  runPyScript("AEC3 echo cancellation (LiveKit)", `from livekit.rtc import AudioFrame
from livekit.rtc.apm import AudioProcessingModule
apm = AudioProcessingModule(echo_cancellation=True, noise_suppression=True)
`, 30000);

  // 5. Audio device selection
  p.log.info("Detecting audio devices...");
  const devices = listAudioDevices();
  const config = loadConfig();

  if (devices.length === 0) {
    p.log.warn("Could not detect audio devices. Using system defaults.");
  } else {
    // Input (microphone)
    const inputDevices = devices.filter((d) => d.inputs > 0);
    if (inputDevices.length > 0) {
      const inputChoice = await p.select({
        message: "Microphone",
        options: [
          { value: "default", label: "System default" },
          ...inputDevices.map((d) => ({
            value: String(d.index),
            label: d.name,
          })),
        ],
      });
      if (!p.isCancel(inputChoice)) {
        if (inputChoice === "default") {
          config.inputDevice = null;
          config.inputDeviceName = "System default";
        } else {
          config.inputDevice = parseInt(inputChoice as string, 10);
          config.inputDeviceName = inputDevices.find((d) => d.index === config.inputDevice)?.name || "Unknown";
        }
      }
    }

    // Output (speaker)
    const outputDevices = devices.filter((d) => d.outputs > 0);
    if (outputDevices.length > 0) {
      const outputChoice = await p.select({
        message: "Speaker",
        options: [
          { value: "default", label: "System default" },
          ...outputDevices.map((d) => ({
            value: String(d.index),
            label: d.name,
          })),
        ],
      });
      if (!p.isCancel(outputChoice)) {
        if (outputChoice === "default") {
          config.outputDevice = null;
          config.outputDeviceName = "System default";
        } else {
          config.outputDevice = parseInt(outputChoice as string, 10);
          config.outputDeviceName = outputDevices.find((d) => d.index === config.outputDevice)?.name || "Unknown";
        }
      }
    }
  }

  // 6. TTS voice
  const voiceChoice = await p.select({
    message: "TTS voice",
    initialValue: config.ttsVoice || "af_heart",
    options: [
      { value: "af_heart", label: "Heart (female, warm)" },
      { value: "af_alloy", label: "Alloy (female, neutral)" },
      { value: "am_adam", label: "Adam (male, deep)" },
      { value: "am_echo", label: "Echo (male, neutral)" },
    ],
  });
  if (!p.isCancel(voiceChoice)) {
    config.ttsVoice = voiceChoice as string;
  }

  // Save config
  saveConfig(config);

  // 7. Mic test
  const testMic = await p.confirm({ message: "Test microphone?", initialValue: true });
  if (!p.isCancel(testMic) && testMic) {
    p.log.info("Recording 3 seconds... speak now!");
    try {
      const deviceArg = config.inputDevice !== null && config.inputDevice !== undefined
        ? `device=${config.inputDevice}, ` : "";
      const testFile = path.join(VOICE_DIR, "_test_mic.py");
      fs.writeFileSync(testFile, `import sounddevice as sd, numpy as np
audio = sd.rec(int(3 * 16000), samplerate=16000, channels=1, ${deviceArg}dtype='float32')
sd.wait()
level = np.abs(audio).mean()
print(f"{level:.6f}")
`);
      const level = execSync(`${getVenvPython()} ${testFile}`, {
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
      try { fs.unlinkSync(testFile); } catch {}
      const vol = parseFloat(level);
      if (vol > 0.001) {
        p.log.success(`Microphone working (level: ${(vol * 100).toFixed(1)}%)`);
      } else {
        p.log.warn("Microphone level very low. Check your input device.");
      }
    } catch (err) {
      p.log.warn(`Mic test failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Summary
  p.note(
    [
      `Mic:     ${config.inputDeviceName || "System default"}`,
      `Speaker: ${config.outputDeviceName || "System default"}`,
      `Voice:   ${config.ttsVoice || "af_heart"}`,
      `Config:  ${CONFIG_FILE}`,
      "",
      `Run: meso run <agent> --voice`,
    ].join("\n"),
    "Voice mode configured",
  );

  p.outro("Ready");
}
