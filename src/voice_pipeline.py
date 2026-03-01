#!/usr/bin/env python3
"""
Lunix Voice Pipeline
====================
Receives raw PCM audio from Raspberry Pi (UDP port 5002),
applies energy-based VAD to detect utterances,
transcribes with faster-whisper (CUDA),
filters for the trigger word (TRIGGER_WORD, default: "Lunix"),
POSTs the cleaned transcription to the Lunix orchestrator,
and speaks the response via TTS cast to a Google Home / Chromecast.

Audio format from Pi: mono, s16le, 48 000 Hz

TTS engines (set TTS_ENGINE env var):
  kokoro  — local Kokoro-82M neural TTS (default, no API key needed)
  openai  — OpenAI TTS API (needs OPENAI_TTS_KEY, highest quality)
  edge    — Microsoft edge-tts (fallback, no key needed)
  xtts    — XTTS v2 local server (best French, voice cloning)
"""

import asyncio
import io
import json
import os
import queue as _queue
import re
import socket
import struct
import threading
import time
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pychromecast
import requests
import soundfile as sf
import torch
from faster_whisper import WhisperModel
from scipy import signal as scipy_signal
from silero_vad import load_silero_vad, VADIterator

# ── Config ────────────────────────────────────────────────────────────────────
LISTEN_PORT      = int(os.getenv("VOICE_UDP_PORT", "5002"))
YUI_URL          = os.getenv("YUI_URL", "http://localhost:3000/order")
YUI_STREAM_URL   = os.getenv("YUI_STREAM_URL", YUI_URL + "/stream")
BEARER_TOKEN     = os.getenv("BEARER_TOKEN", "yui")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
WHISPER_LANG  = os.getenv("WHISPER_LANG", "fr")
LOG_LEVEL     = os.getenv("LOG_LEVEL", "INFO").upper()

# Trigger word — only utterances containing this word are sent to the orchestrator
TRIGGER_WORD  = os.getenv("TRIGGER_WORD", "Lunix").strip()

# Whisper initial_prompt — biases the decoder to expect the trigger word
# so it's transcribed correctly instead of being hallucinated as a similar word.
WHISPER_PROMPT = os.getenv(
    "WHISPER_PROMPT",
    f"Transcription en français. Assistant vocal : {TRIGGER_WORD}. "
    f"Exemple : « {TRIGGER_WORD}, allume les lumières. »",
)
# In conversation mode we don't need the trigger word bias — use a neutral prompt.
WHISPER_CONVO_PROMPT = "Transcription en français. Conversation naturelle avec l'assistant vocal."

# TTS / Cast
TTS_ENGINE    = os.getenv("TTS_ENGINE", "kokoro")     # kokoro | openai | edge | xtts
TTS_SPEAKER   = os.getenv("TTS_SPEAKER", "Google Home")
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
XTTS_SPEED      = float(os.getenv("XTTS_SPEED", "1.0"))

# edge-tts
EDGE_VOICE    = os.getenv("EDGE_VOICE", "fr-FR-DeniseNeural")

# Audio params (must match Pi's ffmpeg output)
SAMPLE_RATE   = 48_000
SAMPLE_WIDTH  = 2
WHISPER_RATE  = 16_000

# Audio frame — 20ms at 48kHz
FRAME_MS      = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000   # 960 samples
FRAME_BYTES   = FRAME_SAMPLES * SAMPLE_WIDTH      # 1920 bytes

# Silero VAD — replaces energy-based VAD
# Silero requires 16kHz float32 audio in 512-sample chunks (32ms).
# We resample each 48kHz frame (960 samples → 320 samples at 16kHz)
# and feed into Silero's VADIterator which handles start/end detection.
SILERO_THRESHOLD      = float(os.getenv("SILERO_THRESHOLD", "0.5"))
SILERO_MIN_SILENCE_MS = int(os.getenv("SILERO_MIN_SILENCE_MS", "1200"))
SILERO_CHUNK          = 512   # samples at 16kHz (required by Silero)

# Conversation mode — after Yui responds, the next utterance(s) don't need the
# trigger word. Window resets on each response.
CONVERSATION_WINDOW_S = float(os.getenv("CONVERSATION_WINDOW_S", "20"))

# Stop words — saying any of these during playback interrupts the assistant.
_RAW_STOP_WORDS = os.getenv("STOP_WORDS", "stop,arrête,attends,tais-toi,silence,pause")
STOP_WORDS = [w.strip() for w in _RAW_STOP_WORDS.split(",") if w.strip()]

# Speaker verification — uses resemblyzer to reject audio that doesn't match
# the user's voice (prevents the Pi mic from picking up the Chromecast speaker).
# Needs: pip install resemblyzer --break-system-packages
# Needs: assets/my_voice.wav  (record with: npm run record-voice)
SPEAKER_REF_WAV           = os.getenv("SPEAKER_REF_WAV",
                                os.path.join(os.path.dirname(__file__), "../assets/my_voice.wav"))
SPEAKER_SIMILARITY_THRESH = float(os.getenv("SPEAKER_SIMILARITY_THRESH", "0.75"))

# Pre-buffer: keep last 300ms of 48kHz audio before speech start
# so we don't clip the first syllable while Silero fires 'start'
PRE_BUFFER_BYTES = int(SAMPLE_RATE * SAMPLE_WIDTH * 0.3)  # ~28800 bytes

MIN_UTTERANCE_S = 0.5
MAX_UTTERANCE_S = 20.0

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
log.info(f"Whisper ready. Trigger word: '{TRIGGER_WORD}'")

# ── Silero VAD ─────────────────────────────────────────────────────────────────
log.info("Loading Silero VAD model…")
_silero_model = load_silero_vad()
log.info(f"Silero VAD ready (threshold={SILERO_THRESHOLD}, min_silence={SILERO_MIN_SILENCE_MS}ms)")


def _make_vad_iterator(min_silence_ms: int = SILERO_MIN_SILENCE_MS) -> VADIterator:
    return VADIterator(
        _silero_model,
        threshold=SILERO_THRESHOLD,
        sampling_rate=WHISPER_RATE,
        min_silence_duration_ms=min_silence_ms,
        speech_pad_ms=100,
    )


# ── Speaker verification (optional — requires resemblyzer) ────────────────────
_encoder = None
_user_embedding = None

try:
    from resemblyzer import VoiceEncoder, preprocess_wav as _resemblyzer_preprocess
    _encoder = VoiceEncoder()
    _ref_path = os.path.realpath(SPEAKER_REF_WAV)
    if os.path.exists(_ref_path):
        _ref_wav = _resemblyzer_preprocess(_ref_path)
        _user_embedding = _encoder.embed_utterance(_ref_wav)
        log.info(f"Speaker verification: ON (ref={_ref_path}, threshold={SPEAKER_SIMILARITY_THRESH})")
    else:
        log.info(f"Speaker verification: OFF (reference not found at {_ref_path} — run: npm run record-voice)")
except ImportError:
    log.info("Speaker verification: OFF (resemblyzer not installed — run: pip install resemblyzer --break-system-packages)")

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


# ── Conversation mode state ───────────────────────────────────────────────────
# Set to future timestamp after each cast response so the next utterance(s)
# don't require the trigger word.
_conversation_mode_until: float = 0.0


def transcribe(audio_16k: np.ndarray, conversation_mode: bool = False) -> str:
    prompt = WHISPER_CONVO_PROMPT if conversation_mode else WHISPER_PROMPT
    segments, _ = model.transcribe(
        audio_16k,
        language=WHISPER_LANG,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
        initial_prompt=prompt,
    )
    return " ".join(s.text for s in segments).strip()


# ── Trigger word helpers ───────────────────────────────────────────────────────

_trigger_pattern = re.compile(rf'\b{re.escape(TRIGGER_WORD)}\b', re.IGNORECASE)


def contains_trigger(text: str) -> bool:
    """Return True if the trigger word appears in the transcribed text."""
    return bool(_trigger_pattern.search(text))


def strip_trigger(text: str) -> str:
    """
    Remove the trigger word and any surrounding punctuation/spaces from the text.

    Examples:
      "Lunix, allume les lumières"               → "allume les lumières"
      "allume les lumières s'il te plaît Lunix"  → "allume les lumières s'il te plaît"
      "Peux-tu Lunix me faire un résumé ?"       → "Peux-tu me faire un résumé ?"
    """
    # Remove trigger word along with an optional leading/trailing comma or space
    cleaned = _trigger_pattern.sub('', text)
    # Collapse multiple whitespace, remove leading/trailing punctuation
    cleaned = re.sub(r'\s+', ' ', cleaned).strip().lstrip(',.!?').rstrip().strip()
    return cleaned


# ── Stop word helpers ─────────────────────────────────────────────────────────

_stop_pattern = re.compile(
    r'\b(' + '|'.join(re.escape(w) for w in STOP_WORDS) + r')\b',
    re.IGNORECASE,
) if STOP_WORDS else None


def contains_stop_word(text: str) -> bool:
    return bool(_stop_pattern and _stop_pattern.search(text))


def strip_stop_words(text: str) -> str:
    """Remove stop words and surrounding punctuation, return the remainder."""
    if not _stop_pattern:
        return text
    cleaned = _stop_pattern.sub('', text)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip().lstrip(',.!?').strip()
    return cleaned


# ── Speaker verification ──────────────────────────────────────────────────────

def is_user_voice(audio_16k: np.ndarray) -> bool:
    """
    Returns True if the audio sounds like the registered user voice.
    Always returns True when resemblyzer is not set up (fail-open).
    """
    if _encoder is None or _user_embedding is None:
        return True
    try:
        emb = _encoder.embed_utterance(audio_16k)
        sim = float(np.dot(emb, _user_embedding))
        log.info(f"Speaker similarity: {sim:.3f} (threshold={SPEAKER_SIMILARITY_THRESH})")
        return sim >= SPEAKER_SIMILARITY_THRESH
    except Exception:
        return True


# ── Playback interrupt state ──────────────────────────────────────────────────

_stop_event    = threading.Event()   # set by stop-word listener to interrupt playback
_stop_utterance: str = ""            # the full transcription that triggered the stop


# ── WAV helpers ───────────────────────────────────────────────────────────────

def _wav_duration(wav_bytes: bytes) -> float:
    """Return duration in seconds by scanning the WAV header for the data chunk."""
    try:
        idx = wav_bytes.find(b"data", 12)
        if idx == -1:
            return 3.0
        data_size    = struct.unpack_from("<I", wav_bytes, idx + 4)[0]
        channels     = struct.unpack_from("<H", wav_bytes, 22)[0]
        sample_rate  = struct.unpack_from("<I", wav_bytes, 24)[0]
        bits_per_sam = struct.unpack_from("<H", wav_bytes, 34)[0]
        bps = bits_per_sam // 8
        if bps == 0 or channels == 0 or sample_rate == 0:
            return 3.0
        return (data_size // (bps * channels)) / sample_rate
    except Exception:
        return 3.0


# ── Trigger chime ─────────────────────────────────────────────────────────────

def _generate_chime_wav() -> bytes:
    """
    Generate a short two-tone confirmation chime as a WAV byte string.
    880 Hz → 1760 Hz, 0.15 s each, with 20 ms fade-in/out and 40 ms gap.
    """
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
    log.info("Trigger chime ready (two-tone 880→1760 Hz, 0.34 s)")
except Exception as _chime_err:
    _CHIME_WAV = None
    log.warning(f"Could not generate chime: {_chime_err}")


def play_chime() -> None:
    """Play the trigger confirmation chime on the cast device (non-blocking)."""
    if _CHIME_WAV:
        threading.Thread(
            target=_play_audio_blocking, args=(_CHIME_WAV, "audio/wav"), daemon=True
        ).start()


# ── Sentence splitter ─────────────────────────────────────────────────────────

def _find_sentence_end(buf: str) -> int:
    """
    Return the index of the first sentence-ending character (. ! ?)
    that is followed by whitespace (or is at end of string).
    Ignores decimal numbers like '3.5' by checking the char before '.'.
    Returns -1 if no boundary found yet.
    """
    for i, ch in enumerate(buf):
        if ch in ".!?" and i >= 5:
            # Don't split on decimal numbers (digit before '.')
            if ch == "." and i > 0 and buf[i - 1].isdigit():
                continue
            next_ch = buf[i + 1] if i + 1 < len(buf) else " "
            if next_ch in " \n\r\t":
                return i
    return -1


# ── Blocking playback on the Google speaker ───────────────────────────────────

def _play_audio_blocking(audio: bytes, mime: str) -> None:
    """
    Store audio in the TTS HTTP server and tell the Google speaker to play it.
    Blocks until the audio has finished playing by polling the Chromecast
    player_state — more reliable than a fixed timer since it accounts for
    variable Chromecast buffering latency.
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

        # Compute duration as a fallback deadline so we never block forever
        if "wav" in mime:
            duration = _wav_duration(audio)
        else:
            duration = max(1.0, len(audio) / 16_000)

        log.debug(f"Playback: ~{duration:.1f}s  ({len(audio)} bytes, {mime})")

        # Phase 1 — sleep for most of the duration, checking _stop_event every 50ms.
        min_wait = max(0.1, duration - 0.5)
        deadline1 = time.time() + min_wait
        while time.time() < deadline1:
            if _stop_event.is_set():
                try:
                    mc.stop()
                except Exception:
                    pass
                return
            time.sleep(0.05)

        # Phase 2 — poll player_state for the tail, still checking _stop_event.
        deadline2 = time.time() + 1.0
        while time.time() < deadline2:
            if _stop_event.is_set():
                try:
                    mc.stop()
                except Exception:
                    pass
                return
            state = getattr(mc.status, "player_state", None)
            if state not in ("PLAYING", "BUFFERING"):
                break
            time.sleep(0.1)

        time.sleep(0.2)  # short tail buffer for clean transition
    except Exception as e:
        log.error(f"Playback error: {e}")


# ── Stop word listener — runs in parallel with TTS playback ──────────────────

def _listen_for_stop(sock: socket.socket, done: threading.Event) -> None:
    """
    Parallel VAD loop active only during TTS playback.
    Reads from the shared UDP socket, runs fast Silero VAD (500ms silence),
    transcribes utterances, and sets _stop_event if a stop word is detected.
    Uses speaker verification to filter the assistant's own voice picked up
    by the Pi mic.
    """
    global _stop_utterance

    recv_buf   = b""
    speech_buf = b""
    pre_buf    = bytearray()
    recording  = False
    silero_buf = np.array([], dtype=np.float32)
    # Use 500ms silence (vs 1200ms normal) — stop words are short, snappy phrases
    vad_iter   = _make_vad_iterator(min_silence_ms=500)

    log.info("Stop word listener started")

    while not done.is_set() and not _stop_event.is_set():
        try:
            data, _ = sock.recvfrom(65535)
        except socket.timeout:
            continue
        except Exception as e:
            log.warning(f"Stop listener socket error: {e}")
            break

        recv_buf += data

        while len(recv_buf) >= FRAME_BYTES and not done.is_set() and not _stop_event.is_set():
            frame     = recv_buf[:FRAME_BYTES]
            recv_buf  = recv_buf[FRAME_BYTES:]

            if not recording:
                pre_buf += frame
                if len(pre_buf) > PRE_BUFFER_BYTES:
                    pre_buf = pre_buf[-PRE_BUFFER_BYTES:]
            else:
                speech_buf += frame
                dur = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                if dur >= 5.0:  # hard cap at 5s — stop words are short
                    _eval_stop_utterance(speech_buf)
                    speech_buf = b""
                    recording  = False
                    vad_iter   = _make_vad_iterator(min_silence_ms=500)
                    silero_buf = np.array([], dtype=np.float32)
                    continue

            samples_48k = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
            samples_16k = scipy_signal.resample_poly(samples_48k, 1, 3).astype(np.float32)
            silero_buf  = np.concatenate([silero_buf, samples_16k])

            while len(silero_buf) >= SILERO_CHUNK:
                chunk      = torch.from_numpy(silero_buf[:SILERO_CHUNK])
                silero_buf = silero_buf[SILERO_CHUNK:]
                result     = vad_iter(chunk)

                if result is not None:
                    if 'start' in result and not recording:
                        speech_buf = bytes(pre_buf)
                        pre_buf    = bytearray()
                        recording  = True

                    elif 'end' in result and recording:
                        dur = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                        if dur >= 0.3:
                            _eval_stop_utterance(speech_buf)
                        speech_buf = b""
                        recording  = False
                        vad_iter   = _make_vad_iterator(min_silence_ms=500)
                        silero_buf = np.array([], dtype=np.float32)

    log.info("Stop word listener stopped")


def _eval_stop_utterance(speech_buf: bytes) -> None:
    """Transcribe a short utterance and set _stop_event if a stop word is found."""
    global _stop_utterance
    audio = to_whisper(speech_buf)
    # Use neutral Whisper prompt — we're NOT looking for the trigger word here.
    # The trigger-word-biased prompt would interfere with recognising stop words.
    text  = transcribe(audio, conversation_mode=True)
    if not text:
        log.info("[Stop listener] (empty transcription — skipped)")
        return
    log.info(f"[Stop listener] heard: {text!r}")
    # Speaker verification is intentionally skipped for stop words:
    # the TTS voice never says "stop" / "arrête", so there's nothing to filter.
    # Keeping the check would only cause false rejections when the user's voice
    # mixes with Chromecast audio in the Pi mic.
    if contains_stop_word(text):
        _stop_utterance = text
        _stop_event.set()
        log.info(f"Stop word detected: {text!r}")


# ── Orchestrator call — streaming ─────────────────────────────────────────────

def post_order(
    text: str,
    sock: socket.socket | None = None,
    reset_convo: bool = False,
) -> None:
    """
    Send the transcribed order to the orchestrator via SSE streaming.

    The LLM response is split into sentences as tokens arrive; each sentence
    is dispatched to TTS in a background thread immediately.  The playback
    loop plays sentences sequentially in arrival order, so sentence N plays
    while sentence N+1 is still being synthesised.

    If sock is provided, a parallel stop-word listener runs during playback.
    When a stop word is detected _stop_event is set and playback halts early.

    reset_convo=True tells the orchestrator to clear its conversation history
    before processing — used when starting a fresh conversation (trigger word
    required) so previous topics don't bleed into the new answer.

    Falls back to the blocking /order endpoint on any streaming error.
    """
    global _stop_utterance
    _stop_event.clear()
    _stop_utterance = ""
    log.info(f'Order ({"NEW convo" if reset_convo else "convo"}): "{text}"')

    # ── ordered queue: each slot is a Future-like object that will hold
    #    (audio_bytes, mime) once TTS completes for that sentence ──────────────
    play_queue: _queue.Queue = _queue.Queue()

    class _Slot:
        """A one-shot container filled by a TTS worker thread."""
        def __init__(self):
            self._q: _queue.Queue = _queue.Queue(maxsize=1)
        def put(self, val):
            self._q.put(val)
        def get(self):
            return self._q.get()

    def _tts_worker(sentence: str, slot: _Slot) -> None:
        try:
            audio, mime = _generate_tts(sentence)
            slot.put((audio, mime))
        except Exception as e:
            log.error(f"TTS error ({sentence[:40]!r}): {e}")
            slot.put(None)

    def _flush(sentence: str) -> None:
        """Kick off TTS for one sentence and reserve its slot in the queue."""
        sentence = sentence.strip()
        if not sentence:
            return
        log.debug(f"TTS dispatch: {sentence[:60]!r}")
        slot = _Slot()
        play_queue.put(slot)
        threading.Thread(
            target=_tts_worker, args=(sentence, slot), daemon=True
        ).start()

    def _sse_reader() -> None:
        """Read SSE tokens from /order/stream, split into sentences, flush TTS."""
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
                        log.error(f"Stream error from server: {obj['error']}")
                        break
                    token = obj.get("token", "")
                    if not token:
                        continue
                    buf += token
                    # Flush every sentence as it completes
                    while True:
                        end = _find_sentence_end(buf)
                        if end == -1:
                            break
                        _flush(buf[: end + 1])
                        buf = buf[end + 1 :].lstrip()
                except json.JSONDecodeError:
                    pass
        except Exception as e:
            log.error(f"SSE reader error: {e} — falling back to blocking call")
            # Fallback: call the blocking endpoint with the whole order
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
            play_queue.put(None)  # sentinel — tell playback loop to stop

    # Start SSE reader in background
    threading.Thread(target=_sse_reader, daemon=True).start()

    # Start stop-word listener in parallel (only when a socket is available)
    _stop_listener_done = threading.Event()
    if sock is not None:
        threading.Thread(
            target=_listen_for_stop, args=(sock, _stop_listener_done), daemon=True
        ).start()

    def _drain_play_queue() -> None:
        """Discard all pending slots so TTS workers don't pile up after a stop."""
        while True:
            try:
                play_queue.get_nowait()
            except _queue.Empty:
                break

    # Playback loop — runs on the calling thread, plays sentences in order.
    # Uses a short timeout on get() so _stop_event is checked even during the
    # LLM thinking phase (before any TTS sentence has been queued).
    while True:
        if _stop_event.is_set():
            _drain_play_queue()
            break

        try:
            item = play_queue.get(timeout=0.1)
        except _queue.Empty:
            continue

        if item is None:
            break  # SSE reader sent sentinel — all sentences queued

        if _stop_event.is_set():
            _drain_play_queue()
            break

        result = item.get()  # blocks until TTS is ready for this sentence
        if result is None:
            continue
        audio, mime = result
        _play_audio_blocking(audio, mime)
        if _stop_event.is_set():
            _drain_play_queue()
            break

    _stop_listener_done.set()  # signal listener to exit if playback ended naturally


# ── Main VAD loop ─────────────────────────────────────────────────────────────
def _drain_udp(sock: socket.socket) -> None:
    """
    Discard all bytes queued in the UDP kernel buffer.
    Called after post_order() returns to prevent Lunix's own voice (played back
    through the room speaker and picked up by the Pi mic) from being
    transcribed as a new voice command.
    """
    sock.settimeout(0.0)
    try:
        while True:
            sock.recvfrom(65535)
    except (BlockingIOError, socket.error):
        pass
    finally:
        sock.settimeout(0.5)


def _process_utterance(speech_buf: bytes, sock: socket.socket) -> None:
    """
    Transcribe a captured utterance and forward it to the orchestrator.

    In normal mode the trigger word is required.
    In conversation mode (active for CONVERSATION_WINDOW_S seconds after each
    cast response) the trigger word is optional — any utterance is forwarded.
    """
    global _conversation_mode_until

    in_convo = time.time() < _conversation_mode_until
    audio = to_whisper(speech_buf)
    text = transcribe(audio, conversation_mode=in_convo)

    # Always log — essential for debugging VAD and trigger detection
    log.info(f"Transcription: {text!r}" if text else "Transcription: (empty — Whisper found no speech)")

    if not text:
        return

    if in_convo:
        # Conversation mode — no trigger word required.
        # Strip it anyway if the user happened to say it.
        order = strip_trigger(text) if contains_trigger(text) else text
        log.info(f"[Conversation mode] → Order: {order!r}")
    else:
        if not contains_trigger(text):
            log.info(f"No trigger word '{TRIGGER_WORD}' — ignored")
            return
        order = strip_trigger(text)
        if not order:
            log.info(f"Trigger found but nothing left after stripping: {text!r}")
            return
        log.info(f"→ Order: {order!r}")

    play_chime()   # non-blocking: fires immediately, LLM call starts in parallel
    # reset_convo=True when this is a new conversation (trigger word was required),
    # so the orchestrator discards old history and starts fresh.
    post_order(order, sock=sock, reset_convo=not in_convo)

    if _stop_event.is_set():
        # User interrupted playback — build a context message for the orchestrator
        follow_up = strip_stop_words(_stop_utterance).strip()
        if follow_up:
            interrupt_msg = (
                f"L'utilisateur t'a interrompu(e) en disant : « {follow_up} ». "
                f"Réponds directement à ça, de façon concise."
            )
        else:
            interrupt_msg = (
                "L'utilisateur t'a interrompu(e) (il a dit « stop »). "
                "Demande-lui brièvement ce qu'il souhaite savoir."
            )
        log.info(f"Interrupted. Sending context: {interrupt_msg!r}")
        _drain_udp(sock)
        # Interrupt follow-up stays in the same conversation (reset_convo=False)
        post_order(interrupt_msg, sock=sock, reset_convo=False)

    # Extend conversation window — 10s after cast ends, trigger word not needed
    _conversation_mode_until = time.time() + CONVERSATION_WINDOW_S
    log.info(f"Conversation window: {CONVERSATION_WINDOW_S:.0f}s")

    _drain_udp(sock)


def main() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    sock.bind(("0.0.0.0", LISTEN_PORT))
    sock.settimeout(0.5)

    log.info(f"Listening for audio on UDP :{LISTEN_PORT}…")
    log.info(f"Trigger word: '{TRIGGER_WORD}' — say it anywhere in the sentence")
    log.info(f"Silero VAD: threshold={SILERO_THRESHOLD} min_silence={SILERO_MIN_SILENCE_MS}ms")

    recv_buf   = b""
    speech_buf = b""          # 48kHz PCM captured since speech start
    pre_buf    = bytearray()  # rolling 300ms pre-buffer (before Silero fires 'start')
    recording  = False

    # Silero accumulator — feed 512-sample chunks at 16kHz
    silero_buf = np.array([], dtype=np.float32)
    vad_iter   = _make_vad_iterator()

    # RMS stats — logged every 5s for monitoring
    stat_frames = 0
    stat_sum    = 0.0
    stat_max    = 0.0
    STAT_INTERVAL = 250  # 250 × 20ms = 5 seconds

    while True:
        try:
            data, _ = sock.recvfrom(65535)
        except socket.timeout:
            # Stream gap — if mid-utterance, force end
            if recording and speech_buf:
                duration = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                if duration >= MIN_UTTERANCE_S:
                    _process_utterance(speech_buf, sock)
                speech_buf = b""
                recording = False
                vad_iter = _make_vad_iterator()
                silero_buf = np.array([], dtype=np.float32)
            continue

        recv_buf += data

        while len(recv_buf) >= FRAME_BYTES:
            frame = recv_buf[:FRAME_BYTES]
            recv_buf = recv_buf[FRAME_BYTES:]

            # ── RMS stats (monitoring only, no longer drives VAD) ─────────────
            energy = rms(frame)
            stat_frames += 1
            stat_sum += energy
            stat_max = max(stat_max, energy)
            if stat_frames >= STAT_INTERVAL:
                avg = stat_sum / stat_frames
                log.info(f"[RMS 5s] avg={avg:.0f}  max={stat_max:.0f}  recording={recording}")
                stat_frames = 0
                stat_sum    = 0.0
                stat_max    = 0.0

            # ── Pre-buffer (always keep last 300ms before speech start) ───────
            if not recording:
                pre_buf += frame
                if len(pre_buf) > PRE_BUFFER_BYTES:
                    pre_buf = pre_buf[-PRE_BUFFER_BYTES:]
            else:
                speech_buf += frame
                # Safety cap
                duration = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                if duration >= MAX_UTTERANCE_S:
                    log.info(f"MAX_UTTERANCE reached ({duration:.1f}s) — forcing transcription")
                    _process_utterance(speech_buf, sock)
                    speech_buf = b""
                    recording  = False
                    vad_iter   = _make_vad_iterator()
                    silero_buf = np.array([], dtype=np.float32)
                    pre_buf    = bytearray()
                    continue

            # ── Resample frame 48kHz → 16kHz for Silero ──────────────────────
            samples_48k = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
            samples_16k = scipy_signal.resample_poly(samples_48k, 1, 3).astype(np.float32)
            silero_buf  = np.concatenate([silero_buf, samples_16k])

            # ── Feed 512-sample chunks to Silero ──────────────────────────────
            while len(silero_buf) >= SILERO_CHUNK:
                chunk = torch.from_numpy(silero_buf[:SILERO_CHUNK])
                silero_buf = silero_buf[SILERO_CHUNK:]

                result = vad_iter(chunk)

                if result is not None:
                    if 'start' in result and not recording:
                        log.info("Recording started (Silero)")
                        # Prepend pre-buffer so we don't miss the first syllable
                        speech_buf = bytes(pre_buf)
                        pre_buf    = bytearray()
                        recording  = True

                    elif 'end' in result and recording:
                        duration = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                        log.info(f"Recording ended (Silero, {duration:.1f}s)")
                        if duration >= MIN_UTTERANCE_S:
                            _process_utterance(speech_buf, sock)
                        speech_buf = b""
                        recording  = False
                        vad_iter   = _make_vad_iterator()
                        silero_buf = np.array([], dtype=np.float32)
                        pre_buf    = bytearray()


if __name__ == "__main__":
    main()
