#!/usr/bin/env python3
"""
Yui Voice Server — WebSocket STT endpoint
==========================================
Receives audio from the Pi satellite via WebSocket (port 5050),
transcribes with faster-whisper, streams to the orchestrator via SSE,
synthesises the response with XTTS v2, and plays it via Chromecast.

Replaces the old UDP + Porcupine pipeline (voice_pipeline.py).
The satellite (satellite.py on the Pi) handles wake word + VAD.

Dependencies (server-side):
    pip install websockets faster-whisper requests numpy pychromecast
"""

import asyncio
import json
import logging
import os
import queue as _queue
import sys
import threading
import time
import wave

# Configure logging before any voice module is imported (they log at import time)
logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)

import numpy as np
import requests
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import (
    AUDIO_DEBUG_DIR,
    BEARER_TOKEN,
    CONVERSATION_WINDOW_S,
    SAVE_AUDIO_DEBUG,
    YUI_STREAM_URL,
    YUI_URL,
)
from text_utils import contains_trigger, find_sentence_end, strip_trigger
from tts import generate_tts, play_audio_blocking, play_chime

log = logging.getLogger("yui-voice-server")

SATELLITE_WS_PORT = int(os.getenv("SATELLITE_WS_PORT", "5050"))
WHISPER_MIN_RMS = float(os.getenv("WHISPER_MIN_RMS", "400"))


def _save_debug_audio(audio_int16: np.ndarray, label: str) -> None:
    """Always save utterance audio as WAV in AUDIO_DEBUG_DIR for STT quality inspection."""
    try:
        os.makedirs(AUDIO_DEBUG_DIR, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        filename = os.path.join(AUDIO_DEBUG_DIR, f"{ts}_{label}.wav")
        with wave.open(filename, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # int16 = 2 bytes
            wf.setframerate(16000)
            wf.writeframes(audio_int16.tobytes())
        log.info(f"Audio saved: {filename} ({len(audio_int16) // 16000:.1f}s)")
    except Exception as e:
        log.warning(f"Could not save debug audio: {e}")


# ---------------------------------------------------------------------------
# Whisper STT
# ---------------------------------------------------------------------------

class WhisperSTT:
    def __init__(self, model_name: str, device: str = "cuda",
                 compute_type: str = "float16"):
        from faster_whisper import WhisperModel
        log.info(f"Loading Whisper model: {model_name} ({device}/{compute_type})…")
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)
        log.info("Whisper model ready.")

    # Vocabulary hint — biases Whisper decoder toward home automation terms
    INITIAL_PROMPT = (
        "Yui, lumières, Hue, Philips, scène, salon, cuisine, chambre, bureau, couloir, "
        "Spotify, Netflix, YouTube, Chromecast, télé, volume, pause, stop, lecture, "
        "Somfy, volets, serrure, Nuki, minuteur, réveil, rappel, agenda, météo, "
        "allume, éteins, baisse, monte, règle, mets, lance, joue, coupe."
    )

    def transcribe(self, audio_int16: np.ndarray) -> str:
        """Transcribe 16kHz int16 PCM. Returns text or '' if silent/hallucination."""
        audio_float = audio_int16.astype(np.float32) / 32768.0

        # RMS gate — skip Whisper entirely on near-silence
        rms_val = float(np.sqrt(np.mean(audio_float ** 2))) * 32768.0
        if rms_val < WHISPER_MIN_RMS:
            log.info(f"STT skipped: RMS {rms_val:.0f} < {WHISPER_MIN_RMS} (silence gate)")
            return ""

        # Normalize to -3 dBFS so Whisper always gets a strong signal
        peak = np.max(np.abs(audio_float))
        if peak > 0.01:
            audio_float = audio_float * (0.7 / peak)

        segments, info = self.model.transcribe(
            audio_float,
            language="fr",
            initial_prompt=self.INITIAL_PROMPT,
            beam_size=5,
            best_of=5,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
            vad_filter=True,
            vad_parameters=dict(
                threshold=0.5,
                min_speech_duration_ms=250,
                min_silence_duration_ms=1000,
                speech_pad_ms=400,
            ),
            hallucination_silence_threshold=1.0,
            word_timestamps=False,
            suppress_blank=True,
        )

        text = " ".join(seg.text.strip() for seg in segments).strip()

        # Reject if Whisper itself wasn't confident (no_speech_prob high for all segments)
        if not text:
            return ""

        # Post-filter common French hallucinations
        for pattern in [
            "merci d'avoir regardé",
            "sous-titres réalisés par",
            "sous-titres par",
            "merci de votre attention",
            "à bientôt",
            "abonnez-vous",
            "likez",
        ]:
            if pattern in text.lower() and len(text) < len(pattern) + 20:
                log.warning(f"Filtered hallucination: {text!r}")
                return ""

        return text


# ---------------------------------------------------------------------------
# Orchestrator + TTS pipeline
# (mirrors post_order() from voice/pipeline.py, without the stop-word listener)
# ---------------------------------------------------------------------------

_stop_event = threading.Event()
_conversation_mode_until: float = 0.0


def _post_order(text: str, reset_convo: bool = False) -> None:
    """
    Send text to the orchestrator via SSE, TTS each sentence, play on Chromecast.
    Blocks until all TTS playback is complete.
    """
    _stop_event.clear()
    log.info(f'Order ({"NEW convo" if reset_convo else "convo"}): "{text}"')

    play_queue: _queue.Queue = _queue.Queue()

    class _Slot:
        def __init__(self):
            self._q: _queue.Queue = _queue.Queue(maxsize=1)

        def put(self, val):
            self._q.put(val)

        def get(self):
            return self._q.get()

    def _tts_worker(sentence: str, slot: _Slot) -> None:
        try:
            slot.put(generate_tts(sentence))
        except Exception as e:
            log.error(f"TTS error ({sentence[:40]!r}): {e}")
            slot.put(None)

    def _flush(sentence: str) -> None:
        sentence = sentence.strip()
        if not sentence:
            return
        slot = _Slot()
        play_queue.put(slot)
        threading.Thread(target=_tts_worker, args=(sentence, slot), daemon=True).start()

    def _sse_reader() -> None:
        buf = ""
        try:
            resp = requests.post(
                YUI_STREAM_URL,
                json={"order": text, "voice": True, "reset": reset_convo},
                headers={"Authorization": f"Bearer {BEARER_TOKEN}"},
                stream=True,
                timeout=90,
            )
            for raw in resp.iter_lines():
                if not raw:
                    continue
                line = raw.decode("utf-8")
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    if buf.strip():
                        _flush(buf)
                    break
                try:
                    obj = json.loads(data)
                    if "error" in obj:
                        log.error(f"Stream error: {obj['error']}")
                        break
                    token = obj.get("token", "")
                    if not token:
                        continue
                    buf += token
                    while True:
                        end = find_sentence_end(buf)
                        if end == -1:
                            break
                        _flush(buf[: end + 1])
                        buf = buf[end + 1 :].lstrip()
                except json.JSONDecodeError:
                    pass
        except Exception as e:
            log.error(f"SSE error: {e} — falling back to blocking call")
            try:
                resp2 = requests.post(
                    YUI_URL,
                    json={"order": text, "voice": True, "reset": reset_convo},
                    headers={"Authorization": f"Bearer {BEARER_TOKEN}"},
                    timeout=60,
                )
                response_text = resp2.json().get("response", "")
                if response_text:
                    _flush(response_text)
            except Exception as e2:
                log.error(f"Fallback also failed: {e2}")
        finally:
            play_queue.put(None)  # sentinel

    threading.Thread(target=_sse_reader, daemon=True).start()

    # Playback loop — plays sentences in order
    while True:
        if _stop_event.is_set():
            break
        try:
            item = play_queue.get(timeout=0.1)
        except _queue.Empty:
            continue
        if item is None:
            break  # SSE reader sentinel
        if _stop_event.is_set():
            break
        result = item.get()  # blocks until TTS is ready
        if result is None:
            continue
        audio, mime = result
        play_audio_blocking(audio, mime, _stop_event)
        if _stop_event.is_set():
            break


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------

class VoiceServer:
    def __init__(self, model: str, device: str, compute_type: str):
        self.stt = WhisperSTT(model, device, compute_type)
        # Serialise utterances — only one at a time (Whisper + TTS are not re-entrant)
        self._processing_lock = asyncio.Lock()

    async def handle_client(self, websocket) -> None:
        client = websocket.remote_address
        log.info(f"Satellite connected: {client}")

        audio_buffer = bytearray()
        state = "idle"  # idle | recording | processing

        try:
            async for message in websocket:
                if isinstance(message, str):
                    data = json.loads(message)
                    msg_type = data.get("type")

                    if msg_type == "wake":
                        log.info("🎤 Wake signal — recording")
                        audio_buffer.clear()
                        state = "recording"

                    elif msg_type == "end":
                        if state != "recording":
                            continue
                        state = "processing"
                        duration_s = len(audio_buffer) / 2 / 16000
                        log.info(
                            f"Recording complete: {duration_s:.1f}s "
                            f"({len(audio_buffer)} bytes)"
                        )
                        result = await self._process_utterance(bytes(audio_buffer))
                        await websocket.send(json.dumps(result))
                        audio_buffer.clear()
                        state = "idle"

                elif isinstance(message, bytes):
                    if state == "recording":
                        audio_buffer.extend(message)

        except websockets.ConnectionClosed:
            log.info(f"Satellite disconnected: {client}")
        except Exception as e:
            log.error(f"Handler error: {e}", exc_info=True)

    async def _process_utterance(self, audio_bytes: bytes) -> dict:
        global _conversation_mode_until

        if len(audio_bytes) < 3200:  # < 0.1 s
            return {"status": "too_short"}

        pcm = np.frombuffer(audio_bytes, dtype=np.int16)
        loop = asyncio.get_event_loop()

        # Always save audio for STT quality inspection
        await loop.run_in_executor(None, _save_debug_audio, pcm, "utterance")

        # STT (in thread — Whisper is CPU/GPU bound)
        t0 = time.perf_counter()
        text = await loop.run_in_executor(None, self.stt.transcribe, pcm)
        stt_ms = (time.perf_counter() - t0) * 1000

        if not text:
            log.info(f"STT returned empty ({stt_ms:.0f}ms)")
            return {"status": "empty"}

        log.info(f'STT: "{text}" ({stt_ms:.0f}ms)')

        # Strip trigger word if Whisper caught it (satellite already handled wake word)
        order = strip_trigger(text) if contains_trigger(text) else text
        if not order:
            log.info(f"Wake word only, no command: {text!r}")
            return {"status": "no_command"}

        in_convo = time.time() < _conversation_mode_until
        reset_convo = not in_convo

        # Chime + orchestrator + TTS (serialised, blocking, in thread)
        async with self._processing_lock:
            play_chime()
            await loop.run_in_executor(None, _post_order, order, reset_convo)

        _conversation_mode_until = time.time() + CONVERSATION_WINDOW_S
        log.info(f"Conversation window open for {CONVERSATION_WINDOW_S:.0f}s")

        return {"status": "done", "text": order}

    async def start(self, host: str = "0.0.0.0", port: int = SATELLITE_WS_PORT) -> None:
        log.info(f"Voice server starting on ws://{host}:{port}")
        async with websockets.serve(
            self.handle_client,
            host,
            port,
            max_size=10 * 1024 * 1024,  # 10 MB — enough for ~5 min of audio
            ping_interval=None,  # satellite uses websocket-client (sync) which doesn't auto-pong
        ):
            log.info("Voice server ready — waiting for satellite connections")
            await asyncio.Future()  # run forever


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Yui Voice Server (satellite mode)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=SATELLITE_WS_PORT)
    parser.add_argument(
        "--model",
        default=os.getenv("WHISPER_MODEL", "distil-large-v3-fr"),
        help="faster-whisper model name or local path",
    )
    parser.add_argument(
        "--device",
        default=os.getenv("WHISPER_DEVICE", "cuda"),
        help="cuda | cpu",
    )
    parser.add_argument(
        "--compute-type",
        default=os.getenv("WHISPER_COMPUTE_TYPE", "float16"),
        help="float16 | int8 | int8_float16",
    )
    args = parser.parse_args()

    server = VoiceServer(args.model, args.device, args.compute_type)
    asyncio.run(server.start(args.host, args.port))


if __name__ == "__main__":
    main()
