"""Live-tunable voice parameters, persisted to data/voice-tuning.json."""
from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass

log = logging.getLogger("voice")


@dataclass
class VoiceTuning:
    threshold: float = 0.5          # OpenWakeWord trigger threshold [0,1]
    vad_aggressiveness: int = 2     # webrtcvad aggressiveness [0,3]
    gain: float = 1.0               # software input gain [0,4]
    send_to_ai: bool = True         # if False, transcribe but don't forward to the LLM

    def update(self, *, threshold=None, vad_aggressiveness=None, gain=None,
               send_to_ai=None) -> None:
        if threshold is not None:
            self.threshold = max(0.0, min(1.0, float(threshold)))
        if vad_aggressiveness is not None:
            self.vad_aggressiveness = max(0, min(3, int(vad_aggressiveness)))
        if gain is not None:
            self.gain = max(0.0, min(4.0, float(gain)))
        if send_to_ai is not None:
            self.send_to_ai = bool(send_to_ai)

    def to_dict(self) -> dict:
        return asdict(self)


def load_tuning(path: str) -> VoiceTuning:
    try:
        with open(path) as f:
            data = json.load(f)
        t = VoiceTuning()
        t.update(
            threshold=data.get("threshold"),
            vad_aggressiveness=data.get("vad_aggressiveness"),
            gain=data.get("gain"),
            send_to_ai=data.get("send_to_ai"),
        )
        return t
    except (FileNotFoundError, json.JSONDecodeError):
        return VoiceTuning()


def save_tuning(tuning: VoiceTuning, path: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as f:
        json.dump(tuning.to_dict(), f, indent=2)
