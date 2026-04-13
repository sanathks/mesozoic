#!/usr/bin/env python3
"""
Meso Voice Bridge — local STT/TTS pipeline.

Inspired by TrelisResearch/voice-loop (Apache 2.0).

Pipeline:
  Mic → Silero VAD → Smart Turn v3 → Moonshine STT → stdout (transcript)
  stdin (speak chunks) → Kokoro TTS → Speaker (streaming + barge-in)
"""

import os
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TRANSFORMERS_NO_ADVISORY_WARNINGS"] = "1"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
import sys
import json
import queue
import threading
import signal
import tempfile
import time as _time
import warnings
warnings.filterwarnings("ignore", message=".*unauthenticated.*")
import numpy as np
import sounddevice as sd

# Larger audio buffer — more robust to CPU saturation during inference
sd.default.latency = "high"

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 512  # 32ms at 16kHz (required by Silero VAD)
SILENCE_MS = int(os.environ.get("MESO_VOICE_SILENCE_MS", "900"))
SILENCE_LIMIT = max(1, int(SILENCE_MS / (CHUNK_SAMPLES / SAMPLE_RATE * 1000)))
SMART_TURN_THRESHOLD = 0.65  # higher = more certain the turn is over (0.5 was too eager)
VAD_THRESHOLD = 0.5
BARGE_IN_THRESHOLD = 0.8
BARGE_IN_CONSEC = 5  # consecutive speech chunks needed to interrupt

INPUT_DEVICE = int(os.environ["MESO_VOICE_INPUT_DEVICE"]) if os.environ.get("MESO_VOICE_INPUT_DEVICE") else None
OUTPUT_DEVICE = int(os.environ["MESO_VOICE_OUTPUT_DEVICE"]) if os.environ.get("MESO_VOICE_OUTPUT_DEVICE") else None
TTS_VOICE = os.environ.get("MESO_VOICE_TTS_VOICE", "af_heart")

# ─── JSON Protocol ──────────────────────────────────────────────────────────

def emit(msg: dict):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()

def emit_error(message: str):
    emit({"type": "error", "message": message})

# ─── Audio State ─────────────────────────────────────────────────────────────

audio_q: queue.Queue[np.ndarray] = queue.Queue()
is_speaking = False
should_stop = False

def audio_callback(indata, frames, time_info, status):
    audio_q.put(indata[:, 0].copy())

def drain_audio_q():
    while not audio_q.empty():
        audio_q.get_nowait()

# ─── VAD ─────────────────────────────────────────────────────────────────────

def vad_prob(vad_model, chunk):
    import torch
    p = vad_model(torch.from_numpy(chunk).float(), SAMPLE_RATE)
    return p.item() if hasattr(p, "item") else float(p)

# ─── Smart Turn Detection ───────────────────────────────────────────────────

def load_smart_turn():
    """Load Smart Turn v3 — transformer-based endpoint detection."""
    try:
        import onnxruntime as ort
        from transformers import WhisperFeatureExtractor
    except ImportError:
        return None

    model_path = os.path.join(tempfile.gettempdir(), "smart_turn_v3", "smart_turn_v3.2_cpu.onnx")
    if not os.path.exists(model_path):
        emit({"type": "status", "message": "Downloading Smart Turn v3 model..."})
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        import urllib.request
        urllib.request.urlretrieve(
            "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx",
            model_path,
        )

    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    extractor = WhisperFeatureExtractor.from_pretrained("openai/whisper-tiny")

    def predict(audio_float32: np.ndarray) -> float:
        max_samples = 8 * SAMPLE_RATE
        audio_float32 = audio_float32[-max_samples:]
        features = extractor(
            audio_float32,
            sampling_rate=SAMPLE_RATE,
            max_length=max_samples,
            padding="max_length",
            return_attention_mask=False,
            return_tensors="np",
        )
        return float(
            session.run(None, {"input_features": features.input_features.astype(np.float32)})[0].flatten()[0]
        )

    return predict

# ─── STT ─────────────────────────────────────────────────────────────────────

def transcribe(stt_model_name: str, audio: np.ndarray) -> str:
    try:
        from moonshine_onnx import transcribe as moonshine_transcribe
        result = moonshine_transcribe(audio, stt_model_name)
        if isinstance(result, list):
            return " ".join(t for t in result if t and t.strip())
        return str(result)
    except Exception as e:
        emit_error(f"Transcription error: {e}")
        return ""

# ─── TTS + Playback ─────────────────────────────────────────────────────────

# ─── AEC3 Echo Cancellation ──────────────────────────────────────────────────

AEC_FRAME = 160  # 10ms @ 16kHz — required by WebRTC AEC3

def _make_aec_processor():
    """Create WebRTC AEC3 processor via LiveKit APM."""
    try:
        from livekit.rtc import AudioFrame
        from livekit.rtc.apm import AudioProcessingModule
    except ImportError:
        return None

    apm = AudioProcessingModule(echo_cancellation=True, noise_suppression=True)

    def _to_i16(x):
        s = (x * 32767).clip(-32768, 32767).astype(np.int16)
        return np.pad(s, (0, max(0, AEC_FRAME - len(s)))) if len(s) < AEC_FRAME else s

    def _frame(b):
        return AudioFrame(b.tobytes(), sample_rate=SAMPLE_RATE, num_channels=1, samples_per_channel=AEC_FRAME)

    def process(mic: np.ndarray, ref: np.ndarray) -> np.ndarray:
        cleaned = np.zeros_like(mic)
        for i in range(0, len(mic), AEC_FRAME):
            mic_f = _frame(_to_i16(mic[i:i + AEC_FRAME]))
            apm.process_reverse_stream(_frame(_to_i16(ref[i:i + AEC_FRAME])))
            apm.process_stream(mic_f)
            out = np.frombuffer(bytes(mic_f.data), dtype=np.int16).astype(np.float32) / 32767
            cleaned[i:i + AEC_FRAME] = out[:len(mic[i:i + AEC_FRAME])]
        return cleaned

    return process


def speak_streaming(tts_model, text: str, vad_model):
    """Stream TTS with AEC3 echo cancellation + barge-in detection.
    Uses Kokoro's async streaming API for low time-to-first-audio."""
    global is_speaking
    import asyncio

    try:
        is_speaking = True
        drain_audio_q()
        if vad_model is not None:
            vad_model.reset_states()

        aec_process = _make_aec_processor()
        tts_16k_buf: list[np.ndarray] = []
        consec_speech = 0
        play_start = 0.0
        mic_pos = 0
        out_stream = None
        interrupted = False

        def _lang_from_voice(v: str) -> str:
            prefix = v[:1] if len(v) > 1 and v[1] == '_' else ''
            return {'a': 'en-us', 'b': 'en-gb', 'e': 'es', 'f': 'fr-fr',
                    'h': 'hi', 'i': 'it', 'j': 'ja', 'p': 'pt-br', 'z': 'cmn'}.get(prefix, 'en-us')

        def check_barge_in():
            nonlocal consec_speech, mic_pos
            if not play_start or _time.monotonic() - play_start < 0.5:
                return False
            tts_concat = np.concatenate(tts_16k_buf) if tts_16k_buf else np.array([], dtype=np.float32)
            while not audio_q.empty():
                mic_chunk = audio_q.get_nowait()
                if len(mic_chunk) < CHUNK_SAMPLES:
                    continue
                if aec_process is not None and len(tts_concat) > 0:
                    ref_end = min(mic_pos + len(mic_chunk), len(tts_concat))
                    ref = tts_concat[mic_pos:ref_end]
                    if len(ref) < len(mic_chunk):
                        ref = np.concatenate([ref, np.zeros(len(mic_chunk) - len(ref), dtype=np.float32)])
                    mic_pos += len(mic_chunk)
                    cleaned = aec_process(mic_chunk, ref)
                else:
                    cleaned = mic_chunk
                if vad_prob(vad_model, cleaned.astype(np.float32)) > BARGE_IN_THRESHOLD:
                    consec_speech += 1
                    if consec_speech >= BARGE_IN_CONSEC:
                        return True
                else:
                    consec_speech = 0
            return False

        async def _play():
            nonlocal out_stream, interrupted, play_start
            tts_stream = tts_model.create_stream(
                text, voice=TTS_VOICE, speed=1.0, lang=_lang_from_voice(TTS_VOICE))

            async for chunk_samples, sr in tts_stream:
                if out_stream is None:
                    out_stream = sd.OutputStream(samplerate=sr, channels=1, dtype="float32", device=OUTPUT_DEVICE)
                    out_stream.start()
                    drain_audio_q()
                    if vad_model is not None:
                        vad_model.reset_states()
                    play_start = _time.monotonic()

                # Store 16kHz reference for AEC
                if sr == SAMPLE_RATE:
                    tts_16k_buf.append(chunk_samples.astype(np.float32))
                else:
                    idx = np.arange(0, len(chunk_samples), sr / SAMPLE_RATE)
                    tts_16k_buf.append(np.interp(idx, np.arange(len(chunk_samples)), chunk_samples).astype(np.float32))

                data = chunk_samples.reshape(-1, 1)
                for i in range(0, len(data), 4096):
                    if vad_model is not None and check_barge_in():
                        interrupted = True
                        break
                    out_stream.write(data[i:i + 4096])
                if interrupted:
                    break

            if out_stream:
                out_stream.stop()
                out_stream.close()

        asyncio.run(_play())
        if interrupted:
            emit({"type": "interrupt"})
    except Exception as e:
        emit_error(f"TTS failed: {e}")
    finally:
        is_speaking = False
        drain_audio_q()
        if vad_model is not None:
            vad_model.reset_states()

# ─── Listen Loop ─────────────────────────────────────────────────────────────

def listen_loop(vad_model, stt_model_name, smart_turn):
    global should_stop

    buf = []
    speaking = False
    silent_chunks = 0

    emit({"type": "listening"})

    while not should_stop:
        # While TTS is playing, don't consume mic chunks — the barge-in
        # detector in speak_streaming() needs them from audio_q.
        if is_speaking:
            _time.sleep(0.05)
            continue

        try:
            chunk = audio_q.get(timeout=0.1)
        except queue.Empty:
            continue

        if len(chunk) < CHUNK_SAMPLES:
            continue

        speech_prob = vad_prob(vad_model, chunk)

        if speech_prob > VAD_THRESHOLD:
            if not speaking:
                speaking = True
            silent_chunks = 0
            buf.append(chunk)
        elif speaking:
            silent_chunks += 1
            buf.append(chunk)

            if silent_chunks < SILENCE_LIMIT:
                continue

            # Smart Turn: check if this is a real endpoint or just a pause
            if smart_turn and buf:
                turn_prob = smart_turn(np.concatenate(buf))
                if turn_prob < SMART_TURN_THRESHOLD:
                    # Not confident enough — wait for more silence
                    # But don't wait forever: after 2x silence limit, force process
                    if silent_chunks < SILENCE_LIMIT * 2:
                        continue
                    # Extended silence — process even with low turn prob

            # Speech ended — transcribe
            audio_data = np.concatenate(buf)
            duration = len(audio_data) / SAMPLE_RATE

            if duration > 0.3:  # at least 300ms of audio
                text = transcribe(stt_model_name, audio_data)
                if text and text.strip():
                    emit({"type": "transcript", "text": text.strip()})

            buf.clear()
            speaking = False
            silent_chunks = 0
            vad_model.reset_states()
            emit({"type": "listening"})

# ─── Stdin Reader ────────────────────────────────────────────────────────────

def stdin_reader(tts_model, vad_model):
    global should_stop

    text_buffer = []

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        msg_type = msg.get("type")

        if msg_type == "speak_chunk":
            text_buffer.append(msg.get("text", ""))

        elif msg_type == "speak_end":
            full_text = "".join(text_buffer).strip()
            text_buffer.clear()
            if full_text:
                speak_streaming(tts_model, full_text, vad_model)
                emit({"type": "listening"})

        elif msg_type == "stop":
            should_stop = True
            break

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    global should_stop

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))

    emit({"type": "status", "message": "Loading models..."})

    # VAD
    try:
        from silero_vad import load_silero_vad
        vad_model = load_silero_vad(onnx=True)
        emit({"type": "status", "message": "VAD loaded"})
    except Exception as e:
        emit_error(f"Failed to load VAD: {e}")
        sys.exit(1)

    # STT
    try:
        from moonshine_onnx import MoonshineOnnxModel
        MoonshineOnnxModel(model_name="moonshine/base")  # warm up / download
        stt_model_name = "moonshine/base"
        emit({"type": "status", "message": "STT loaded (Moonshine)"})
    except Exception as e:
        emit_error(f"Failed to load STT: {e}")
        sys.exit(1)

    # TTS
    try:
        from kokoro_onnx import Kokoro
        models_dir = os.path.expanduser("~/.meso/voice/models")
        model_path = os.path.join(models_dir, "kokoro-v1.0.onnx")
        voices_path = os.path.join(models_dir, "voices-v1.0.bin")
        tts_model = Kokoro(model_path, voices_path)
        emit({"type": "status", "message": "TTS loaded (Kokoro)"})
    except Exception as e:
        emit_error(f"Failed to load TTS: {e}")
        sys.exit(1)

    # Smart Turn (optional — needs transformers + onnxruntime)
    smart_turn = None
    try:
        smart_turn = load_smart_turn()
        if smart_turn:
            emit({"type": "status", "message": "Smart Turn v3 loaded"})
    except Exception:
        emit({"type": "status", "message": "Smart Turn not available (using silence detection only)"})

    emit({"type": "ready"})

    # Mic stream
    try:
        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            blocksize=CHUNK_SAMPLES,
            dtype="float32",
            device=INPUT_DEVICE,
            callback=audio_callback,
        )
        stream.start()
    except Exception as e:
        emit_error(f"Microphone not available: {e}")
        sys.exit(1)

    # Stdin reader in background
    stdin_thread = threading.Thread(target=stdin_reader, args=(tts_model, vad_model), daemon=True)
    stdin_thread.start()

    # Listen loop
    try:
        listen_loop(vad_model, stt_model_name, smart_turn)
    except KeyboardInterrupt:
        pass
    finally:
        stream.stop()
        stream.close()
        emit({"type": "stopped"})


if __name__ == "__main__":
    main()
