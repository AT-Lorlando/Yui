"""
Picovoice Porcupine wrapper for always-on wake word detection.

Loaded once at startup. Processes frame_length-sample chunks (512 samples /
32ms at 16kHz). Returns True when the wake word is detected, False otherwise.
Falls back gracefully if the model file is missing or pvporcupine is not
installed.

Model trained at: https://console.picovoice.ai/
"""
import logging
import os

import numpy as np

from .config import PORCUPINE_ACCESS_KEY, PORCUPINE_MODEL_PATH

log = logging.getLogger("voice")

_porcupine = None
_frame_length: int = 512  # updated after successful load


def load_wakeword_model() -> bool:
    """
    Load the Porcupine engine. Returns True if successful, False if unavailable.
    Called once at pipeline startup.
    """
    global _porcupine, _frame_length

    if not PORCUPINE_ACCESS_KEY:
        log.info("PORCUPINE_ACCESS_KEY not set — wakeword disabled")
        return False

    if not PORCUPINE_MODEL_PATH or not os.path.exists(PORCUPINE_MODEL_PATH):
        log.warning(
            f"Porcupine model not found: {PORCUPINE_MODEL_PATH}\n"
            "  → Train a custom keyword at https://console.picovoice.ai/\n"
            "  → Then place the .ppn file at the path above."
        )
        return False

    try:
        import pvporcupine  # type: ignore
    except ImportError:
        log.warning("pvporcupine not installed — run: pip install pvporcupine")
        return False

    try:
        _porcupine = pvporcupine.create(
            access_key=PORCUPINE_ACCESS_KEY,
            keyword_paths=[PORCUPINE_MODEL_PATH],
        )
        _frame_length = _porcupine.frame_length
        log.info(
            f"Porcupine loaded: {PORCUPINE_MODEL_PATH} "
            f"(frame_length={_frame_length}, sample_rate={_porcupine.sample_rate})"
        )
        return True
    except Exception as e:
        log.error(f"Failed to load Porcupine: {e}")
        return False


def get_frame_length() -> int:
    """Return the required chunk size in samples (512 by default)."""
    return _frame_length


def detect(chunk: np.ndarray) -> bool:
    """
    Run Porcupine inference on exactly frame_length int16 samples.
    Returns True if the wake word was detected, False otherwise.
    """
    if _porcupine is None:
        return False
    try:
        result = _porcupine.process(chunk)
        detected = result >= 0
        if detected:
            log.debug(f"[Porcupine] keyword detected (index={result})")
        return detected
    except Exception as e:
        log.debug(f"Porcupine inference error: {e}")
        return False


def is_available() -> bool:
    return _porcupine is not None


def cleanup() -> None:
    """Release Porcupine engine resources. Call on shutdown."""
    global _porcupine
    if _porcupine is not None:
        try:
            _porcupine.delete()
        except Exception:
            pass
        _porcupine = None
