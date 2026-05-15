"""
Optional speaker verification via resemblyzer.

Fails open: if resemblyzer is not installed or the reference WAV is missing,
is_user_voice() always returns True.
"""
import logging
import os

import numpy as np

from .config import SPEAKER_REF_WAV, SPEAKER_SIMILARITY_THRESH

log = logging.getLogger("voice")

_encoder = None
_user_embedding = None

try:
    from resemblyzer import VoiceEncoder
    from resemblyzer import preprocess_wav as _preprocess

    _encoder = VoiceEncoder()
    _ref_path = os.path.realpath(SPEAKER_REF_WAV)
    if os.path.exists(_ref_path):
        _user_embedding = _encoder.embed_utterance(_preprocess(_ref_path))
        log.info(
            f"Speaker verification: ON "
            f"(ref={_ref_path}, threshold={SPEAKER_SIMILARITY_THRESH})"
        )
    else:
        log.info(
            f"Speaker verification: OFF "
            f"(reference not found at {_ref_path} — run: npm run record-voice)"
        )
except ImportError:
    log.info(
        "Speaker verification: OFF "
        "(resemblyzer not installed — pip install resemblyzer --break-system-packages)"
    )


def is_user_voice(audio_16k: np.ndarray) -> bool:
    """Return True if the audio matches the registered user's voice embedding."""
    if _encoder is None or _user_embedding is None:
        return True
    try:
        sim = float(np.dot(_encoder.embed_utterance(audio_16k), _user_embedding))
        log.info(f"Speaker similarity: {sim:.3f} (threshold={SPEAKER_SIMILARITY_THRESH})")
        return sim >= SPEAKER_SIMILARITY_THRESH
    except Exception:
        return True
