#!/usr/bin/env python3
"""
Yui Voice Server — server-side continuous pipeline
==================================================
Runs the full voice pipeline on the server: UDP audio in → OpenWakeWord →
webrtcvad utterance capture → faster-whisper STT → orchestrator (SSE) →
XTTS v2 → Chromecast. A DebugHub exposes live audio/score and tuning over
a WebSocket for the debug page.

Dependencies (server-side):
    pip install websockets faster-whisper requests numpy pychromecast \\
        openwakeword webrtcvad
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import (
    AUDIO_DEBUG_DIR,
    BEARER_TOKEN,
    CONVERSATION_WINDOW_S,
    SAVE_AUDIO_DEBUG,
    STOP_WORDS,
    YUI_STREAM_URL,
    YUI_URL,
)
from text_utils import contains_trigger, find_sentence_end, strip_trigger
from tts import generate_tts, play_audio_blocking, play_chime

log = logging.getLogger("yui-voice-server")

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
            # Upstream UtteranceCapture already segments speech with webrtcvad;
            # faster-whisper's internal Silero VAD was rejecting 100% of the
            # (mono, downmixed) utterance audio, so disable it here.
            vad_filter=False,
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
# Server-side continuous pipeline
# ---------------------------------------------------------------------------

import threading
from audio_source import AudioSource
from wake import WakeDetector, OWW_CHUNK
from vad_capture import UtteranceCapture
from tuning import load_tuning, save_tuning
from debug_hub import DebugHub
from config import AUDIO_UDP_PORT, DEBUG_WS_PORT, WAKEWORD_NAME

_TUNING_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "voice-tuning.json")
_WAKE_WAV_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "voice-debug", "wakes")


class VoicePipeline:
    def __init__(self, stt: "WhisperSTT", hub: DebugHub, tuning):
        self.stt = stt
        self.hub = hub
        self.tuning = tuning
        self.model_path = os.getenv("WAKEWORD_MODEL",
            os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "wakeword", f"{WAKEWORD_NAME}.onnx"))
        self.source = AudioSource(AUDIO_UDP_PORT, get_gain=lambda: self.tuning.gain)
        self.wake = WakeDetector(self.model_path)
        self.running = False

    def _new_capture(self) -> UtteranceCapture:
        import webrtcvad
        vad = webrtcvad.Vad(self.tuning.vad_aggressiveness)
        return UtteranceCapture(vad)

    def _capture_and_handle(self, conversation: bool) -> None:
        cap = self._new_capture()
        cap.reset()
        utterance = None
        while self.running and utterance is None:
            chunk = self.source.read(OWW_CHUNK)
            self.hub.publish_audio(chunk)
            utterance = cap.feed(chunk)
        if utterance is None or len(utterance) < 16000 // 2:    # < 0.5s -> ignore
            return
        text = self.stt.transcribe(utterance)
        _save_debug_audio(utterance, "utterance")
        if not text.strip():
            log.info("empty transcription - ignored")
            return
        wav_url = self._save_wake_wav(utterance)
        self.hub.record_wake(self.tuning.threshold, text, wav_url)
        lowered = text.strip().lower()
        if any(lowered == w or lowered.startswith(w) for w in STOP_WORDS):
            log.info(f"stop-word utterance: {text!r}")
            return
        clean = strip_trigger(text)
        if not self.tuning.send_to_ai:
            log.info(f"send_to_ai OFF — dry-run, not forwarding: {clean!r}")
            return
        _post_order(clean, reset_convo=not conversation)

    def _save_wake_wav(self, pcm: np.ndarray) -> str:
        import wave, time
        os.makedirs(_WAKE_WAV_DIR, exist_ok=True)
        name = f"wake-{int(time.time()*1000)}.wav"
        with wave.open(os.path.join(_WAKE_WAV_DIR, name), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes(pcm.tobytes())
        return f"/voice-debug/wakes/{name}"

    def run(self) -> None:
        self.running = True
        self.source.start()
        log.info("Voice pipeline listening (UDP audio -> OWW -> VAD -> Whisper)")
        while self.running:
            chunk = self.source.read(OWW_CHUNK)
            self.hub.publish_audio(chunk)
            in_convo = time.time() < _conversation_mode_until
            score = self.wake.score(chunk)
            self.hub.publish_score(score)
            if score >= self.tuning.threshold or in_convo:
                if not in_convo:
                    play_chime()
                    log.info(f"wake fired (score={score:.3f})")
                self._capture_and_handle(conversation=in_convo)
                self.wake.reset()

    def stop(self) -> None:
        self.running = False
        self.source.stop()


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="Yui Voice Server (server-side pipeline)")
    parser.add_argument("--whisper-model", default=os.getenv("WHISPER_MODEL", "distil-large-v3-fr"))
    parser.add_argument("--whisper-device", default=os.getenv("WHISPER_DEVICE", "cuda"))
    parser.add_argument("--whisper-compute", default=os.getenv("WHISPER_COMPUTE_TYPE", "float16"))
    args = parser.parse_args()

    tuning = load_tuning(_TUNING_PATH)

    def on_tuning_change() -> None:
        save_tuning(tuning, _TUNING_PATH)

    hub = DebugHub(tuning, on_tuning_change, DEBUG_WS_PORT)
    stt = WhisperSTT(args.whisper_model, args.whisper_device, args.whisper_compute)
    pipeline = VoicePipeline(stt, hub, tuning)

    t = threading.Thread(target=pipeline.run, daemon=True)
    t.start()
    try:
        asyncio.run(hub.serve())
    except KeyboardInterrupt:
        pipeline.stop()


if __name__ == "__main__":
    main()
