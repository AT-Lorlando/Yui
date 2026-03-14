"""
All environment variables and constants for the voice pipeline.
Every other module imports from here — no env reads elsewhere.
"""
import os

# ── Orchestrator ──────────────────────────────────────────────────────────────
YUI_URL        = os.getenv("YUI_URL", "http://localhost:3000/order")
YUI_STREAM_URL = os.getenv("YUI_STREAM_URL", YUI_URL + "/stream")
BEARER_TOKEN   = os.getenv("BEARER_TOKEN", "yui")

# ── Audio input ───────────────────────────────────────────────────────────────
LISTEN_PORT  = int(os.getenv("VOICE_UDP_PORT", "5002"))
SAMPLE_RATE  = 16_000   # ReSpeaker XVF3800 native rate — stream directly, no resampling
SAMPLE_WIDTH = 2        # bytes per sample (int16)
WHISPER_RATE = 16_000   # faster-whisper expects 16kHz (same as SAMPLE_RATE)

FRAME_MS      = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000   # 320 samples at 16kHz
FRAME_BYTES   = FRAME_SAMPLES * SAMPLE_WIDTH      # 640 bytes

# Pre-buffer: keep last 300ms before speech start so we don't clip first syllable
PRE_BUFFER_BYTES = int(SAMPLE_RATE * SAMPLE_WIDTH * 0.3)  # ~9600 bytes
MIN_UTTERANCE_S  = 0.5
MAX_UTTERANCE_S  = 20.0

# ── Whisper / ASR ─────────────────────────────────────────────────────────────
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
WHISPER_LANG  = os.getenv("WHISPER_LANG", "fr")
LOG_LEVEL     = os.getenv("LOG_LEVEL", "INFO").upper()

WAKEWORD_NAME = os.getenv("WAKEWORD_NAME", "yui")

TRIGGER_WORD = os.getenv("TRIGGER_WORD", WAKEWORD_NAME).strip()

# Do NOT include the trigger word or example commands — Whisper auto-completes
# prompts on silence/noise, which causes hallucinated trigger detections.
WHISPER_PROMPT = os.getenv(
    "WHISPER_PROMPT",
    "Transcription en français. Parole spontanée.",
)
WHISPER_CONVO_PROMPT = os.getenv(
    "WHISPER_CONVO_PROMPT",
    "Transcription en français. Conversation naturelle.",
)

# Minimum RMS energy to send audio to Whisper. Below this = noise, skip entirely.
WHISPER_MIN_RMS = float(os.getenv("WHISPER_MIN_RMS", "400"))

# ── Silero VAD ────────────────────────────────────────────────────────────────
SILERO_THRESHOLD      = float(os.getenv("SILERO_THRESHOLD", "0.5"))
SILERO_MIN_SILENCE_MS = int(os.getenv("SILERO_MIN_SILENCE_MS", "1200"))
SILERO_CHUNK          = 512   # samples at 16kHz (Silero requirement)

# ── Picovoice Porcupine ────────────────────────────────────────────────────────
PORCUPINE_ACCESS_KEY = os.getenv("PORCUPINE_ACCESS_KEY", "")
PORCUPINE_MODEL_PATH = os.getenv("PORCUPINE_MODEL_PATH", f"assets/wakeword/{WAKEWORD_NAME}.ppn")
WAKEWORD_CHUNK       = 512    # Porcupine frame_length (samples at 16kHz); actual value read dynamically after load

# ── TTS / Cast — XTTS v2 via xtts_server.py ──────────────────────────────────
XTTS_SERVER_URL  = os.getenv("XTTS_SERVER_URL", "http://localhost:18770/tts")
XTTS_SPEAKER     = os.getenv("XTTS_SPEAKER", "Lilya Stainthorpe")
XTTS_SPEAKER_WAV = os.getenv("XTTS_SPEAKER_WAV", "")   # path to voice clone WAV
XTTS_SPEED       = float(os.getenv("XTTS_SPEED", "1.0"))

SAVE_AUDIO_DEBUG = os.getenv("SAVE_AUDIO_DEBUG", "").lower() in ("1", "true", "yes")
AUDIO_DEBUG_DIR  = os.getenv("AUDIO_DEBUG_DIR", "data/audio-debug")

TTS_SPEAKER = os.getenv("TTS_SPEAKER", "Salon")
LOCAL_IP    = os.getenv("LOCAL_IP", "10.0.0.101")
TTS_PORT    = int(os.getenv("TTS_PORT", "18765"))
SPEAK_PORT  = int(os.getenv("SPEAK_PORT", "3001"))

# ── Conversation / stop words ─────────────────────────────────────────────────
CONVERSATION_WINDOW_S = float(os.getenv("CONVERSATION_WINDOW_S", "20"))

_RAW_STOP_WORDS = os.getenv("STOP_WORDS", "stop,arrête,attends,tais-toi,silence,pause")
STOP_WORDS = [w.strip() for w in _RAW_STOP_WORDS.split(",") if w.strip()]

# ── Speaker verification (optional, requires resemblyzer) ─────────────────────
SPEAKER_REF_WAV = os.getenv(
    "SPEAKER_REF_WAV",
    os.path.join(os.path.dirname(__file__), "../../assets/my_voice.wav"),
)
SPEAKER_SIMILARITY_THRESH = float(os.getenv("SPEAKER_SIMILARITY_THRESH", "0.75"))
