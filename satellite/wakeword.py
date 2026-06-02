#!/usr/bin/env python3
"""
OpenWakeWord-based wake word engine for the Yui satellite.

Thin wrapper around openwakeword's canonical ``Model`` (melspectrogram +
embedding backbones + wake word model). Feed fixed-size 16 kHz int16 chunks of
``OWW_CHUNK`` samples; ``Model`` keeps the rolling feature buffer internally and
returns a score in [0, 1].

The model is selected by ``model_path``, which accepts either:
  - a filesystem path to a custom-trained .onnx (e.g. assets/wakeword/yui.onnx)
  - a bundled pretrained model name (e.g. "hey_jarvis", "alexa", "hey_mycroft")
    resolved from the openwakeword package resources.

Backbones ship bundled with the openwakeword pip package — no download needed.

Dependencies (Pi): openwakeword==0.4.0, onnxruntime, numpy
"""
from __future__ import annotations

import logging
import os

import numpy as np

log = logging.getLogger("yui-satellite")

# OWW processes audio in 1280-sample chunks (80 ms @ 16 kHz).
OWW_CHUNK = 1280
# Surface any score at or above this floor at INFO level, to ease threshold
# tuning from the logs (silence scores ~0.0, so this stays quiet when idle).
LOG_FLOOR = 0.1
# Chunks of silence fed on reset() to flush the rolling feature buffers
# (~2.5 s — longer than the inference window) so the just-fired wake word
# cannot immediately re-trigger after an utterance.
FLUSH_CHUNKS = 32


def _resolve_model(model: str) -> str:
    """Return a filesystem path for ``model``.

    Accepts a real file path, or a bundled openwakeword model name such as
    "hey_jarvis" / "hey_jarvis_v0.1".
    """
    if os.path.isfile(model):
        return model

    import openwakeword

    res_dir = os.path.join(
        os.path.dirname(openwakeword.__file__), "resources", "models"
    )
    available = sorted(f for f in os.listdir(res_dir) if f.endswith(".onnx"))
    match = next(
        (
            f
            for f in available
            if f == model or f == f"{model}.onnx" or f.startswith(f"{model}_v")
        ),
        None,
    )
    if match is None:
        raise FileNotFoundError(
            f"Wake word model '{model}' is neither a file nor a bundled model. "
            f"Bundled: {available}"
        )
    return os.path.join(res_dir, match)


class WakeWordEngine:
    """Scores OWW_CHUNK-sized int16 frames; fires when score >= threshold."""

    frame_length = OWW_CHUNK

    def __init__(self, model_path: str, threshold: float = 0.5):
        from openwakeword.model import Model

        self.threshold = threshold
        path = _resolve_model(model_path)
        self._model = Model(wakeword_model_paths=[path])
        # openwakeword registers the model under a key derived from the filename.
        self._key = list(self._model.models.keys())[0]
        log.info(
            f"OpenWakeWord ready (model={path}, key={self._key}, "
            f"threshold={threshold}, frame_length={self.frame_length})"
        )

    def score(self, pcm_int16: np.ndarray) -> float:
        """Feed one OWW_CHUNK frame, return current wake score in [0, 1]."""
        preds = self._model.predict(pcm_int16)
        return float(preds[self._key])

    def process(self, pcm_int16: np.ndarray) -> bool:
        """Feed one frame; return True if the wake word just fired."""
        s = self.score(pcm_int16)
        if s >= LOG_FLOOR:
            log.info(f"wake score {s:.3f} (threshold {self.threshold})")
        if s >= self.threshold:
            log.info(f"Wake score {s:.3f} >= {self.threshold} — FIRED")
            return True
        return False

    def reset(self) -> None:
        """Flush internal buffers so audio captured before/during an utterance
        (notably the wake word that just fired) cannot re-trigger detection.

        ``Model.reset()`` only clears the score history; the preprocessor's
        rolling feature/melspectrogram buffers still hold the wake word, so we
        also push silence through to age it out of the inference window.
        """
        self._model.reset()
        silence = np.zeros(OWW_CHUNK, dtype=np.int16)
        for _ in range(FLUSH_CHUNKS):
            self._model.predict(silence)

    def cleanup(self) -> None:
        pass  # openwakeword / onnxruntime need no explicit teardown
