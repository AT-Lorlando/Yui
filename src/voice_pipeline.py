#!/usr/bin/env python3
"""
Yui Voice Pipeline
==================
Receives raw PCM audio from Raspberry Pi (UDP port 5002),
applies energy-based VAD to detect utterances,
transcribes with faster-whisper (CUDA),
POSTs the transcription to the Yui orchestrator,
and speaks the response via TTS cast to a Google Home / Chromecast.

Audio format from Pi: mono, s16le, 48 000 Hz

TTS engines (set TTS_ENGINE env var):
  kokoro  — local Kokoro-82M neural TTS (default, no API key needed)
  openai  — OpenAI TTS API (needs OPENAI_TTS_KEY, highest quality)
  edge    — Microsoft edge-tts (fallback, no key needed)
"""

import asyncio
import io
import os
import socket
import threading
import time
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pychromecast
import requests
from faster_whisper import WhisperModel
from scipy import signal as scipy_signal

# ── Config ────────────────────────────────────────────────────────────────────
LISTEN_PORT   = int(os.getenv("VOICE_UDP_PORT", "5002"))
YUI_URL       = os.getenv("YUI_URL", "http://localhost:3000/order")
BEARER_TOKEN  = os.getenv("BEARER_TOKEN", "yui")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_LANG  = os.getenv("WHISPER_LANG", "fr")
LOG_LEVEL     = os.getenv("LOG_LEVEL", "INFO").upper()

# TTS / Cast
TTS_ENGINE    = os.getenv("TTS_ENGINE", "kokoro")     # kokoro | openai | edge
TTS_SPEAKER   = os.getenv("TTS_SPEAKER", "Salon")
LOCAL_IP      = os.getenv("LOCAL_IP", "10.0.0.101")
TTS_PORT      = int(os.getenv("TTS_PORT", "18765"))

# Kokoro
KOKORO_VOICE  = os.getenv("KOKORO_VOICE", "ff_siwis")  # French female voice
KOKORO_LANG   = os.getenv("KOKORO_LANG", "f")          # 'f' = French

# OpenAI TTS
OPENAI_TTS_KEY   = os.getenv("OPENAI_TTS_KEY", "")
OPENAI_TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "nova")   # nova | shimmer | alloy | echo | fable | onyx
OPENAI_TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "tts-1-hd")

# XTTS (via local xtts_server.py)
XTTS_SERVER_URL = os.getenv("XTTS_SERVER_URL", "http://localhost:18770/tts")
XTTS_SPEAKER    = os.getenv("XTTS_SPEAKER", "Lilya Stainthorpe")
XTTS_SPEAKER_WAV = os.getenv("XTTS_SPEAKER_WAV", "")  # path to voice clone WAV
XTTS_SPEED      = float(os.getenv("XTTS_SPEED", "1.15"))

# edge-tts
EDGE_VOICE    = os.getenv("EDGE_VOICE", "fr-FR-DeniseNeural")

# Audio params (must match Pi's ffmpeg output)
SAMPLE_RATE   = 48_000
SAMPLE_WIDTH  = 2

# VAD params
FRAME_MS      = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES   = FRAME_SAMPLES * SAMPLE_WIDTH

SPEECH_THRESHOLD   = 300
SILENCE_THRESHOLD  = 200
SPEECH_HOLD_FRAMES = 8
SILENCE_END_FRAMES = 40

MIN_UTTERANCE_S = 0.5
MAX_UTTERANCE_S = 12.0
WHISPER_RATE    = 16_000

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("voice")

# ── Whisper ───────────────────────────────────────────────────────────────────
log.info(f"Loading Whisper model '{WHISPER_MODEL}' on CUDA…")
model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
log.info("Whisper ready.")

# ── TTS engine init ───────────────────────────────────────────────────────────
_kokoro_pipeline = None

if TTS_ENGINE == "kokoro":
    log.info("Loading Kokoro TTS pipeline…")
    import warnings
    warnings.filterwarnings("ignore")   # suppress Kokoro phonemizer warnings
    from kokoro import KPipeline
    import soundfile as sf
    _kokoro_pipeline = KPipeline(lang_code=KOKORO_LANG)
    log.info(f"Kokoro ready (voice={KOKORO_VOICE})")

elif TTS_ENGINE == "openai":
    if not OPENAI_TTS_KEY:
        raise RuntimeError("TTS_ENGINE=openai requires OPENAI_TTS_KEY to be set")
    from openai import OpenAI as _OpenAI
    _openai_tts = _OpenAI(api_key=OPENAI_TTS_KEY)
    log.info(f"OpenAI TTS ready (model={OPENAI_TTS_MODEL}, voice={OPENAI_TTS_VOICE})")

elif TTS_ENGINE == "xtts":
    log.info(f"XTTS server at {XTTS_SERVER_URL} (speaker='{XTTS_SPEAKER_WAV or XTTS_SPEAKER}', speed={XTTS_SPEED})")

elif TTS_ENGINE == "edge":
    import edge_tts as _edge_tts
    log.info(f"edge-tts ready (voice={EDGE_VOICE})")

else:
    raise ValueError(f"Unknown TTS_ENGINE: {TTS_ENGINE!r}. Use xtts | kokoro | openai | edge")


def _generate_tts(text: str) -> tuple[bytes, str]:
    """Returns (audio_bytes, mime_type)."""
    if TTS_ENGINE == "kokoro":
        import soundfile as sf
        chunks = []
        for _, _, audio in _kokoro_pipeline(text, voice=KOKORO_VOICE):
            chunks.append(audio)
        audio_np = np.concatenate(chunks)
        buf = io.BytesIO()
        sf.write(buf, audio_np, 24000, format="WAV")
        return buf.getvalue(), "audio/wav"

    elif TTS_ENGINE == "xtts":
        payload: dict = {"text": text, "language": "fr", "speed": XTTS_SPEED}
        if XTTS_SPEAKER_WAV:
            payload["speaker_wav"] = XTTS_SPEAKER_WAV
        else:
            payload["speaker"] = XTTS_SPEAKER
        resp = requests.post(XTTS_SERVER_URL, json=payload, timeout=30)
        return resp.content, "audio/wav"

    elif TTS_ENGINE == "openai":
        resp = _openai_tts.audio.speech.create(
            model=OPENAI_TTS_MODEL,
            voice=OPENAI_TTS_VOICE,
            input=text,
        )
        return resp.content, "audio/mpeg"

    else:  # edge
        async def _edge():
            communicate = _edge_tts.Communicate(text, voice=EDGE_VOICE)
            audio = b""
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio += chunk["data"]
            return audio
        return asyncio.run(_edge()), "audio/mpeg"


# ── TTS HTTP server ───────────────────────────────────────────────────────────
_tts_audio: bytes = b""
_tts_mime: str = "audio/wav"
_tts_lock = threading.Lock()


class _TtsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        with _tts_lock:
            audio, mime = _tts_audio, _tts_mime
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, *_):
        pass


_http_server = ThreadingHTTPServer(("0.0.0.0", TTS_PORT), _TtsHandler)
threading.Thread(target=_http_server.serve_forever, daemon=True).start()
log.info(f"TTS HTTP server on :{TTS_PORT}")

# ── Speak HTTP endpoint ────────────────────────────────────────────────────────
# Allows the Node.js scheduler (cron jobs) to trigger speech without going
# through the full VAD pipeline. POST /speak with {"text": "..."}
SPEAK_PORT = int(os.getenv("SPEAK_PORT", "3001"))


class _SpeakHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        import json as _json
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = _json.loads(self.rfile.read(length))
            text = body.get("text", "").strip()
        except Exception:
            self.send_response(400)
            self.end_headers()
            return

        self.send_response(200)
        self.end_headers()

        if text:
            threading.Thread(target=speak, args=(text,), daemon=True).start()

    def log_message(self, *_):
        pass


_speak_server = ThreadingHTTPServer(("0.0.0.0", SPEAK_PORT), _SpeakHandler)
threading.Thread(target=_speak_server.serve_forever, daemon=True).start()
log.info(f"Speak HTTP endpoint on :{SPEAK_PORT}")

# ── Chromecast ────────────────────────────────────────────────────────────────
_cast: pychromecast.Chromecast | None = None


def _discover_cast(name: str) -> None:
    global _cast
    log.info(f"Discovering '{name}' via Bonjour…")
    try:
        chromecasts, browser = pychromecast.get_chromecasts(timeout=10)
        pychromecast.discovery.stop_discovery(browser)
        device = next((cc for cc in chromecasts if cc.name.lower() == name.lower()), None)
        if not device:
            log.warning(f"'{name}' not found on the network.")
            return
        host, port = device.cast_info.host, device.cast_info.port
        log.info(f"Found '{name}' at {host}:{port} — connecting…")
        _cast = pychromecast.get_chromecast_from_host((host, port, None, None, name))
        _cast.wait()
        log.info(f"Connected to '{_cast.name}'")
    except Exception as e:
        log.error(f"Cast discovery failed: {e}")


_discover_cast(TTS_SPEAKER)


def speak(text: str) -> None:
    if not _cast:
        log.debug("No cast device — skipping TTS.")
        return
    try:
        t0 = time.time()
        audio, mime = _generate_tts(text)
        log.debug(f"TTS generated in {time.time()-t0:.1f}s ({len(audio)} bytes, {mime})")

        with _tts_lock:
            global _tts_audio, _tts_mime
            _tts_audio, _tts_mime = audio, mime

        ext = "wav" if "wav" in mime else "mp3"
        url = f"http://{LOCAL_IP}:{TTS_PORT}/tts.{ext}?t={int(time.time())}"
        mc = _cast.media_controller
        mc.play_media(url, mime)
        mc.block_until_active(timeout=10)
        log.info(f"Speaking [{TTS_ENGINE}]: {text[:80]}…")
    except Exception as e:
        log.error(f"TTS/Cast error: {e}")


# ── Audio helpers ─────────────────────────────────────────────────────────────
def rms(pcm_bytes: bytes) -> float:
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    return float(np.sqrt(np.mean(samples**2))) if len(samples) else 0.0


def to_whisper(pcm_bytes: bytes) -> np.ndarray:
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    return scipy_signal.resample_poly(samples, 1, 3).astype(np.float32)


def transcribe(audio_16k: np.ndarray) -> str:
    segments, _ = model.transcribe(
        audio_16k,
        language=WHISPER_LANG,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
    )
    return " ".join(s.text for s in segments).strip()


# ── Orchestrator call ─────────────────────────────────────────────────────────
def post_order(text: str) -> None:
    log.info(f'Order: "{text}"')
    try:
        resp = requests.post(
            YUI_URL,
            json={"order": text},
            headers={"Authorization": f"Bearer {BEARER_TOKEN}"},
            timeout=60,
        )
        response_text = resp.json().get("response", "")
        log.info(f"Yui: {response_text}")
        if response_text:
            speak(response_text)
    except Exception as e:
        log.error(f"POST failed: {e}")


# ── Main VAD loop ─────────────────────────────────────────────────────────────
def main() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    sock.bind(("0.0.0.0", LISTEN_PORT))
    sock.settimeout(0.5)

    log.info(f"Listening for audio on UDP :{LISTEN_PORT}…")

    recv_buf = b""
    speech_buf = b""
    speech_frames = 0
    silence_frames = 0
    recording = False

    while True:
        try:
            data, _ = sock.recvfrom(65535)
        except socket.timeout:
            if recording and speech_buf:
                duration = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                if duration >= MIN_UTTERANCE_S:
                    audio = to_whisper(speech_buf)
                    text = transcribe(audio)
                    if text:
                        post_order(text)
                speech_buf = b""
                recording = False
                speech_frames = 0
                silence_frames = 0
            continue

        recv_buf += data

        while len(recv_buf) >= FRAME_BYTES:
            frame = recv_buf[:FRAME_BYTES]
            recv_buf = recv_buf[FRAME_BYTES:]
            energy = rms(frame)

            if not recording:
                if energy >= SPEECH_THRESHOLD:
                    speech_frames += 1
                    speech_buf += frame
                    if speech_frames >= SPEECH_HOLD_FRAMES:
                        recording = True
                        silence_frames = 0
                        log.debug(f"Speech started (RMS={energy:.0f})")
                else:
                    speech_frames = max(0, speech_frames - 1)
                    if speech_frames == 0:
                        speech_buf = b""
            else:
                speech_buf += frame
                duration = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)

                if energy < SILENCE_THRESHOLD:
                    silence_frames += 1
                else:
                    silence_frames = 0

                if silence_frames >= SILENCE_END_FRAMES or duration >= MAX_UTTERANCE_S:
                    reason = "silence" if silence_frames >= SILENCE_END_FRAMES else "max"
                    log.debug(f"Utterance end ({reason}, {duration:.1f}s)")

                    if duration >= MIN_UTTERANCE_S:
                        audio = to_whisper(speech_buf)
                        text = transcribe(audio)
                        if text:
                            post_order(text)
                        else:
                            log.debug("Empty transcription.")

                    speech_buf = b""
                    recording = False
                    speech_frames = 0
                    silence_frames = 0


if __name__ == "__main__":
    main()
