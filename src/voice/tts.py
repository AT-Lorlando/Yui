"""
TTS module — XTTS v2 only.

Provides:
  generate_tts(text)           → (audio_bytes, mime_type)
  speak(text)                  → simple cast (used by /speak scheduler endpoint)
  play_audio_blocking(…)       → cast + block + stop_event support (used by pipeline)
  play_chime()                 → non-blocking trigger confirmation sound

Also starts two HTTP servers at import time:
  :{TTS_PORT}   — serves the latest TTS audio to the Chromecast
  :{SPEAK_PORT} — POST /speak endpoint for the Node.js scheduler
"""
import io
import json
import logging
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pychromecast
import requests
import soundfile as sf

from .config import (
    LOCAL_IP,
    SPEAK_PORT,
    TTS_PORT,
    TTS_SPEAKER,
    XTTS_SERVER_URL,
    XTTS_SPEAKER,
    XTTS_SPEAKER_WAV,
    XTTS_SPEED,
)

log = logging.getLogger("voice")

# ── TTS generation — XTTS v2 ─────────────────────────────────────────────────

def generate_tts(text: str) -> tuple[bytes, str]:
    """Call the local XTTS server and return (wav_bytes, 'audio/wav')."""
    payload: dict = {"text": text, "language": "fr", "speed": XTTS_SPEED}
    if XTTS_SPEAKER_WAV:
        payload["speaker_wav"] = XTTS_SPEAKER_WAV
    else:
        payload["speaker"] = XTTS_SPEAKER
    resp = requests.post(XTTS_SERVER_URL, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.content, "audio/wav"


# ── TTS HTTP server (Chromecast fetches audio from here) ─────────────────────

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


# ── Chromecast discovery ──────────────────────────────────────────────────────

_cast: pychromecast.Chromecast | None = None


def _discover_cast(name: str) -> None:
    global _cast
    log.info(f"Discovering '{name}' via Bonjour…")
    try:
        chromecasts, browser = pychromecast.get_chromecasts(timeout=10)
        pychromecast.discovery.stop_discovery(browser)
        device = next(
            (cc for cc in chromecasts if cc.name.lower() == name.lower()), None
        )
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


# ── WAV duration helper ───────────────────────────────────────────────────────

def _wav_duration(wav_bytes: bytes) -> float:
    """Parse WAV header to compute audio duration in seconds."""
    try:
        idx = wav_bytes.find(b"data", 12)
        if idx == -1:
            return 3.0
        data_size = struct.unpack_from("<I", wav_bytes, idx + 4)[0]
        channels = struct.unpack_from("<H", wav_bytes, 22)[0]
        sample_rate = struct.unpack_from("<I", wav_bytes, 24)[0]
        bits_per_sample = struct.unpack_from("<H", wav_bytes, 34)[0]
        bps = bits_per_sample // 8
        if bps == 0 or channels == 0 or sample_rate == 0:
            return 3.0
        return (data_size // (bps * channels)) / sample_rate
    except Exception:
        return 3.0


# ── Blocking playback with stop_event support ─────────────────────────────────

def play_audio_blocking(
    audio: bytes, mime: str, stop_event: threading.Event
) -> None:
    """
    Serve audio from the TTS HTTP server and tell the Chromecast to play it.
    Blocks until playback finishes or stop_event is set (in which case playback
    is stopped early).
    """
    if not _cast:
        log.debug("No cast device — skipping playback.")
        return

    audio_id = int(time.time() * 1000)
    ext = "wav" if "wav" in mime else "mp3"

    with _tts_lock:
        global _tts_audio, _tts_mime
        _tts_audio, _tts_mime = audio, mime

    url = f"http://{LOCAL_IP}:{TTS_PORT}/tts.{ext}?t={audio_id}"
    try:
        mc = _cast.media_controller
        mc.play_media(url, mime)
        mc.block_until_active(timeout=10)

        duration = _wav_duration(audio) if "wav" in mime else max(1.0, len(audio) / 16_000)
        log.debug(f"Playback: ~{duration:.1f}s ({len(audio)} bytes, {mime})")

        # Phase 1 — sleep for most of the duration, checking stop_event every 50ms
        deadline1 = time.time() + max(0.1, duration - 0.5)
        while time.time() < deadline1:
            if stop_event.is_set():
                try:
                    mc.stop()
                except Exception:
                    pass
                return
            time.sleep(0.05)

        # Phase 2 — poll player_state for the tail
        deadline2 = time.time() + 1.0
        while time.time() < deadline2:
            if stop_event.is_set():
                try:
                    mc.stop()
                except Exception:
                    pass
                return
            if getattr(mc.status, "player_state", None) not in ("PLAYING", "BUFFERING"):
                break
            time.sleep(0.1)

        time.sleep(0.2)  # short tail buffer for clean transition
    except Exception as e:
        log.error(f"Playback error: {e}")


# ── Simple speak (used by the /speak scheduler endpoint) ─────────────────────

def speak(text: str) -> None:
    """Generate TTS and cast to the speaker. Non-interruptible (scheduler use)."""
    if not _cast:
        log.debug("No cast device — skipping TTS.")
        return
    try:
        t0 = time.time()
        audio, mime = generate_tts(text)
        log.debug(f"TTS generated in {time.time() - t0:.1f}s ({len(audio)} bytes)")

        with _tts_lock:
            global _tts_audio, _tts_mime
            _tts_audio, _tts_mime = audio, mime

        ext = "wav" if "wav" in mime else "mp3"
        url = f"http://{LOCAL_IP}:{TTS_PORT}/tts.{ext}?t={int(time.time())}"
        mc = _cast.media_controller
        mc.play_media(url, mime)
        mc.block_until_active(timeout=10)
        log.info(f"Speaking: {text[:80]}…")
    except Exception as e:
        log.error(f"TTS/Cast error: {e}")


# ── Trigger chime ─────────────────────────────────────────────────────────────

def _generate_chime_wav() -> bytes:
    """Two-tone confirmation chime: 880 Hz → 1760 Hz, 0.15s each, 40ms gap."""
    sr = 22050
    dur = 0.15
    n = int(sr * dur)
    fade = int(sr * 0.02)
    t = np.linspace(0, dur, n, endpoint=False)

    def tone(freq: float) -> np.ndarray:
        w = (np.sin(2 * np.pi * freq * t) * 0.5).astype(np.float32)
        w[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
        w[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
        return w

    silence = np.zeros(int(sr * 0.04), dtype=np.float32)
    audio = np.concatenate([tone(880.0), silence, tone(1760.0)])
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


try:
    _CHIME_WAV = _generate_chime_wav()
    log.info("Trigger chime ready (880→1760 Hz, 0.34s)")
except Exception as _e:
    _CHIME_WAV = None
    log.warning(f"Could not generate chime: {_e}")


def play_chime() -> None:
    """Play the trigger chime on the cast device (non-blocking, non-interruptible)."""
    if not _CHIME_WAV:
        return
    _ev = threading.Event()  # never set → plays to completion
    threading.Thread(
        target=play_audio_blocking, args=(_CHIME_WAV, "audio/wav", _ev), daemon=True
    ).start()


# ── /speak HTTP endpoint (for Node.js scheduler) ─────────────────────────────

class _SpeakHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
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
