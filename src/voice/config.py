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
SAMPLE_RATE  = 48_000   # Pi streams s16le 48kHz mono
SAMPLE_WIDTH = 2        # bytes per sample (int16)
WHISPER_RATE = 16_000   # faster-whisper expects 16kHz

FRAME_MS      = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000   # 960 samples at 48kHz
FRAME_BYTES   = FRAME_SAMPLES * SAMPLE_WIDTH      # 1920 bytes

# Pre-buffer: keep last 300ms before speech start so we don't clip first syllable
PRE_BUFFER_BYTES = int(SAMPLE_RATE * SAMPLE_WIDTH * 0.3)  # ~28800 bytes
MIN_UTTERANCE_S  = 0.5
MAX_UTTERANCE_S  = 20.0

# ── Whisper / ASR ─────────────────────────────────────────────────────────────
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
WHISPER_LANG  = os.getenv("WHISPER_LANG", "fr")
LOG_LEVEL     = os.getenv("LOG_LEVEL", "INFO").upper()

TRIGGER_WORD = os.getenv("TRIGGER_WORD", "Lunix").strip()

WHISPER_PROMPT = os.getenv(
    "WHISPER_PROMPT",
    f"Transcription en français. Assistant vocal : {TRIGGER_WORD}. "
    f"Exemple : « {TRIGGER_WORD}, allume les lumières. »",
)
WHISPER_CONVO_PROMPT = (
    "Transcription en français. Conversation naturelle avec l'assistant vocal."
)

# ── Silero VAD ────────────────────────────────────────────────────────────────
SILERO_THRESHOLD      = float(os.getenv("SILERO_THRESHOLD", "0.5"))
SILERO_MIN_SILENCE_MS = int(os.getenv("SILERO_MIN_SILENCE_MS", "1200"))
SILERO_CHUNK          = 512   # samples at 16kHz (Silero requirement)

# ── TTS / Cast — XTTS v2 via xtts_server.py ──────────────────────────────────
XTTS_SERVER_URL  = os.getenv("XTTS_SERVER_URL", "http://localhost:18770/tts")
XTTS_SPEAKER     = os.getenv("XTTS_SPEAKER", "Lilya Stainthorpe")
XTTS_SPEAKER_WAV = os.getenv("XTTS_SPEAKER_WAV", "")   # path to voice clone WAV
XTTS_SPEED       = float(os.getenv("XTTS_SPEED", "1.0"))

TTS_SPEAKER = os.getenv("TTS_SPEAKER", "Google Home")
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
