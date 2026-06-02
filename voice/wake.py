"""Server-side OpenWakeWord detector (canonical Model; supports custom path or
bundled model name). Mirrors the validated satellite engine."""
from __future__ import annotations

import logging
import os

import numpy as np

log = logging.getLogger("voice")

OWW_CHUNK = 1280          # 80 ms @ 16 kHz
FLUSH_CHUNKS = 32         # ~2.5 s of silence to age out a just-fired wake word


def _resolve_model(model: str) -> str:
    if os.path.isfile(model):
        return model
    import openwakeword
    res = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
    avail = sorted(f for f in os.listdir(res) if f.endswith(".onnx"))
    match = next((f for f in avail if f in (model, f"{model}.onnx") or f.startswith(f"{model}_v")), None)
    if match is None:
        raise FileNotFoundError(f"wake model '{model}' not a file nor bundled: {avail}")
    return os.path.join(res, match)


class WakeDetector:
    def __init__(self, model_path: str):
        from openwakeword.model import Model
        path = _resolve_model(model_path)
        self._model = Model(wakeword_model_paths=[path])
        self._key = list(self._model.models.keys())[0]
        log.info(f"WakeDetector ready (model={path}, key={self._key})")

    def score(self, chunk_int16: np.ndarray) -> float:
        return float(self._model.predict(chunk_int16)[self._key])

    def reset(self) -> None:
        self._model.reset()
        silence = np.zeros(OWW_CHUNK, dtype=np.int16)
        for _ in range(FLUSH_CHUNKS):
            self._model.predict(silence)
