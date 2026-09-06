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
import os
import random
import struct
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pychromecast
import requests
import soundfile as sf

from config import (
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

# Réglages TTS live (page /debug) — injectés par server.py ; None = env only.
_tuning = None


def set_tuning(tuning) -> None:
    global _tuning
    _tuning = tuning


def _tts_params() -> tuple[float, str, str]:
    """(speed, speaker, speaker_wav) — le tuning live prime sur l'env."""
    speed, speaker, wav = XTTS_SPEED, XTTS_SPEAKER, XTTS_SPEAKER_WAV
    t = _tuning
    if t is not None:
        if getattr(t, "tts_speed", 0.0):
            speed = t.tts_speed
        ts = getattr(t, "tts_speaker", "")
        if ts == "clone":
            wav = XTTS_SPEAKER_WAV
        elif ts:
            speaker, wav = ts, ""
    return speed, speaker, wav


def generate_tts(text: str) -> tuple[bytes, str]:
    """Call the local XTTS server and return (wav_bytes, 'audio/wav')."""
    speed, speaker, speaker_wav = _tts_params()
    payload: dict = {"text": text, "language": "fr", "speed": speed}
    if speaker_wav:
        payload["speaker_wav"] = speaker_wav
    else:
        payload["speaker"] = speaker
    resp = requests.post(XTTS_SERVER_URL, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.content, "audio/wav"


# ── Flux gapless ─────────────────────────────────────────────────────────────
# Une seule session cast par réponse : les phrases TTS sont décodées en PCM et
# poussées dans un flux WAV servi en continu (taille RIFF « infinie », HTTP/1.0
# délimité par la fermeture). Fini le play_media + block_until_active PAR
# phrase (~1 s de trou entre chaque).

# Silence inséré entre deux phrases (respiration naturelle).
TTS_GAP_MS = int(os.getenv("TTS_GAP_MS", "150"))


class PcmStream:
    """File de PCM int16 mono consommée par le handler HTTP."""

    def __init__(self, rate: int):
        self.rate = rate
        self.q: "queue.Queue[bytes | None]" = queue.Queue()
        self.pushed_s = 0.0
        self.closed = False

    def push(self, pcm: np.ndarray) -> None:
        if self.closed or len(pcm) == 0:
            return
        self.q.put(pcm.astype("<i2").tobytes())
        self.pushed_s += len(pcm) / self.rate

    def push_gap(self, ms: int = TTS_GAP_MS) -> None:
        if ms > 0:
            self.push(np.zeros(self.rate * ms // 1000, dtype=np.int16))

    def close(self) -> None:
        self.closed = True
        self.q.put(None)


def wav_to_pcm(wav_bytes: bytes) -> tuple[np.ndarray, int]:
    """WAV → (PCM int16 mono, rate)."""
    data, rate = sf.read(io.BytesIO(wav_bytes), dtype="int16", always_2d=True)
    return data.mean(axis=1).astype(np.int16), int(rate)


def stream_wav_header(rate: int) -> bytes:
    """En-tête WAV à tailles « infinies » (0xFFFFFFFF) pour un flux sans fin
    connue — les lecteurs (Chromecast inclus) lisent jusqu'à la fermeture."""
    return (
        b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
        + b"data" + struct.pack("<I", 0xFFFFFFFF)
    )


_stream_lock = threading.Lock()
_current_stream: PcmStream | None = None


def open_stream(rate: int) -> tuple[PcmStream, str]:
    """Enregistre un nouveau flux et renvoie (stream, url à caster)."""
    global _current_stream
    stream = PcmStream(rate)
    with _stream_lock:
        old = _current_stream
        _current_stream = stream
    if old and not old.closed:
        old.close()
    url = f"http://{LOCAL_IP}:{TTS_PORT}/stream.wav?t={int(time.time() * 1000)}"
    return stream, url


# ── TTS HTTP server (Chromecast fetches audio from here) ─────────────────────

_tts_audio: bytes = b""
_tts_mime: str = "audio/wav"
_tts_lock = threading.Lock()


class _TtsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/stream.wav"):
            return self._serve_stream()
        with _tts_lock:
            audio, mime = _tts_audio, _tts_mime
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def _serve_stream(self):
        with _stream_lock:
            stream = _current_stream
        if stream is None:
            self.send_response(404)
            self.end_headers()
            return
        self.protocol_version = "HTTP/1.0"  # fin de flux = fermeture
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.end_headers()
        try:
            self.wfile.write(stream_wav_header(stream.rate))
            self.wfile.flush()
            while True:
                try:
                    chunk = stream.q.get(timeout=30)
                except queue.Empty:
                    break
                if chunk is None:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # le lecteur a raccroché (stop)

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


def start_stream_cast(url: str) -> bool:
    """Lance la lecture du flux gapless sur l'enceinte. False si échec
    (l'appelant retombe sur la lecture phrase par phrase)."""
    if not _cast:
        return False
    try:
        mc = _cast.media_controller
        mc.play_media(url, "audio/wav", stream_type="LIVE")
        mc.block_until_active(timeout=10)
        return True
    except Exception as e:
        log.error(f"Stream cast failed: {e}")
        return False


def wait_stream_end(stream: PcmStream, stop_event: threading.Event) -> None:
    """Bloque jusqu'à la fin de lecture du flux (durée poussée écoulée) ou
    stop_event. Coupe le player dans tous les cas (flux LIVE)."""
    if not _cast:
        return
    mc = _cast.media_controller
    started = time.time()
    while True:
        if stop_event.is_set():
            break
        played = time.time() - started
        if stream.closed and played >= stream.pushed_s + 1.0:
            state = getattr(mc.status, "player_state", None)
            if state not in ("PLAYING", "BUFFERING"):
                break
            if played >= stream.pushed_s + 6.0:
                break  # garde-fou si le player ne rend jamais IDLE
        time.sleep(0.1)
    try:
        mc.stop()
    except Exception:
        pass


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

_CHIMES_DIR = os.path.join(os.path.dirname(__file__), "../../assets/chimes")


def _load_chimes() -> list[bytes]:
    """Load all WAV files from assets/chimes/. Returns empty list if none found."""
    chimes = []
    if not os.path.isdir(_CHIMES_DIR):
        return chimes
    for fname in sorted(os.listdir(_CHIMES_DIR)):
        if not fname.endswith(".wav"):
            continue
        try:
            with open(os.path.join(_CHIMES_DIR, fname), "rb") as f:
                chimes.append(f.read())
        except Exception as e:
            log.warning(f"Could not load chime {fname}: {e}")
    return chimes


def _generate_fallback_chime() -> bytes:
    """Two-tone beep fallback when no TTS chimes are available."""
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


_CHIME_WAVS: list[bytes] = _load_chimes()
if _CHIME_WAVS:
    log.info(f"Chimes loaded: {len(_CHIME_WAVS)} phrase(s) from {_CHIMES_DIR}")
else:
    try:
        _CHIME_WAVS = [_generate_fallback_chime()]
        log.info("No chimes found — using fallback beep (run scripts/generate_chimes.py)")
    except Exception as _e:
        log.warning(f"Could not generate fallback chime: {_e}")


def play_chime() -> None:
    """Play a random confirmation phrase (or fallback beep) on the cast device."""
    if not _CHIME_WAVS:
        return
    wav = random.choice(_CHIME_WAVS)
    _ev = threading.Event()  # never set → plays to completion
    threading.Thread(
        target=play_audio_blocking, args=(wav, "audio/wav", _ev), daemon=True
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
