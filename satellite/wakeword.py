#!/usr/bin/env python3
"""
OpenWakeWord-based wake word engine for the Yui satellite.

Streaming inference: feed fixed-size 16 kHz int16 chunks; the engine accumulates
OWW embedding frames and scores the last 16-frame window through the trained
MLP (yui.onnx). Backbones (melspectrogram + embedding) ship bundled with the
openwakeword pip package — no download needed.

Dependencies (Pi): openwakeword==0.4.0, onnxruntime, numpy
"""
from __future__ import annotations

import logging

import numpy as np

log = logging.getLogger("yui-satellite")

# OWW processes audio in 1280-sample chunks (80 ms @ 16 kHz).
OWW_CHUNK = 1280
# Inference window = 16 embedding frames (~2 s) — matches train_wakeword.py.
N_FRAMES = 16
# yui.onnx tensor names (from torch.onnx.export in train_wakeword.py).
ONNX_INPUT = "x.1"
ONNX_OUTPUT = "53"


class WakeWordEngine:
    """Scores OWW_CHUNK-sized int16 frames; fires when score >= threshold."""

    frame_length = OWW_CHUNK

    def __init__(self, model_path: str, threshold: float = 0.5):
        import onnxruntime as ort
        from openwakeword.utils import AudioFeatures

        self.threshold = threshold
        self._features = AudioFeatures()  # bundled backbones, default paths
        self._session = ort.InferenceSession(
            model_path, providers=["CPUExecutionProvider"]
        )
        log.info(
            f"OpenWakeWord ready (model={model_path}, threshold={threshold}, "
            f"frame_length={self.frame_length})"
        )

    def score(self, pcm_int16: np.ndarray) -> float:
        """Feed one OWW_CHUNK frame, return current wake score in [0, 1]."""
        self._features(pcm_int16)
        feats = self._features.get_features(N_FRAMES).astype(np.float32)
        out = self._session.run([ONNX_OUTPUT], {ONNX_INPUT: feats})[0]
        return float(np.array(out).flatten()[0])

    def process(self, pcm_int16: np.ndarray) -> bool:
        """Feed one frame; return True if the wake word just fired."""
        s = self.score(pcm_int16)
        if s >= self.threshold:
            log.info(f"Wake score {s:.3f} >= {self.threshold} — FIRED")
            return True
        if s >= self.threshold * 0.6:  # log near-misses to help tuning
            log.debug(f"Wake score {s:.3f} (below {self.threshold})")
        return False

    def cleanup(self) -> None:
        pass  # onnxruntime / OWW need no explicit teardown
