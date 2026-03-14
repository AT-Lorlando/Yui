"""
ASR (Automatic Speech Recognition) module.

Loads the Whisper model and Silero VAD at import time.
Provides: rms(), to_whisper(), make_vad_iterator(), transcribe()
"""
import logging

import numpy as np
import torch
from faster_whisper import WhisperModel
from silero_vad import VADIterator, load_silero_vad

from .config import (
    SILERO_CHUNK,
    SILERO_MIN_SILENCE_MS,
    SILERO_THRESHOLD,
    SAMPLE_RATE,
    SAMPLE_WIDTH,
    WHISPER_CONVO_PROMPT,
    WHISPER_LANG,
    WHISPER_MIN_RMS,
    WHISPER_MODEL,
    WHISPER_PROMPT,
    WHISPER_RATE,
)

log = logging.getLogger("voice")

# ── Whisper ───────────────────────────────────────────────────────────────────
log.info(f"Loading Whisper model '{WHISPER_MODEL}' on CUDA…")
_whisper = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
log.info("Whisper ready.")

# ── Silero VAD ────────────────────────────────────────────────────────────────
log.info("Loading Silero VAD model…")
_silero_model = load_silero_vad()
log.info(
    f"Silero VAD ready (threshold={SILERO_THRESHOLD}, "
    f"min_silence={SILERO_MIN_SILENCE_MS}ms)"
)


def make_vad_iterator(min_silence_ms: int = SILERO_MIN_SILENCE_MS) -> VADIterator:
    return VADIterator(
        _silero_model,
        threshold=SILERO_THRESHOLD,
        sampling_rate=WHISPER_RATE,
        min_silence_duration_ms=min_silence_ms,
        speech_pad_ms=100,
    )


# ── Audio helpers ─────────────────────────────────────────────────────────────

def rms(pcm_bytes: bytes) -> float:
    """RMS energy of a raw s16le PCM frame (monitoring only, not used for VAD)."""
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    return float(np.sqrt(np.mean(samples**2))) if len(samples) else 0.0


def to_whisper(pcm_bytes: bytes) -> np.ndarray:
    """Convert 16kHz s16le PCM → float32 array for Whisper. No resampling needed."""
    return np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0


# ── Transcription ─────────────────────────────────────────────────────────────

def transcribe(audio_16k: np.ndarray, conversation_mode: bool = False) -> str:
    """
    Transcribe a 16kHz float32 audio segment. Returns the full text, or ""
    if the audio is likely silence/noise.

    Anti-hallucination measures:
      1. RMS gate — skip Whisper entirely if audio is too quiet.
      2. Per-segment no_speech_prob filter — discard segments Whisper itself
         considers silence (common cause of hallucinated trigger words).
    """
    # 1. RMS gate on the 16kHz float32 audio (values in [-1, 1])
    rms_val = float(np.sqrt(np.mean(audio_16k ** 2))) * 32768.0
    if rms_val < WHISPER_MIN_RMS:
        log.info(f"Transcription skipped: RMS {rms_val:.0f} < {WHISPER_MIN_RMS} (noise gate)")
        return ""

    prompt = WHISPER_CONVO_PROMPT if conversation_mode else WHISPER_PROMPT
    segments, _ = _whisper.transcribe(
        audio_16k,
        language=WHISPER_LANG,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
        initial_prompt=prompt,
        no_speech_threshold=0.5,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
    )

    # 2. Per-segment no_speech_prob filter
    parts = []
    for s in segments:
        if s.no_speech_prob > 0.5:
            log.debug(f"Segment discarded (no_speech_prob={s.no_speech_prob:.2f}): {s.text!r}")
            continue
        parts.append(s.text)

    return " ".join(parts).strip()
