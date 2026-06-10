"""Utterance segmentation via an injected VAD. Feed arbitrary int16 chunks;
returns the full utterance (np.int16) once end-of-speech (silence) or the max
duration is reached."""
from __future__ import annotations

from typing import Optional

import numpy as np

VAD_FRAME_MS = 30


class UtteranceCapture:
    def __init__(self, vad, sample_rate=16000, silence_ms=1200, max_ms=15000, prebuffer_ms=300):
        self._vad = vad
        self._rate = sample_rate
        self._frame = sample_rate * VAD_FRAME_MS // 1000        # 480 @ 16k
        self._silence_frames = max(1, silence_ms // VAD_FRAME_MS)
        self._max_frames = max(1, max_ms // VAD_FRAME_MS)
        self._prebuffer_frames = prebuffer_ms // VAD_FRAME_MS
        self.reset()

    def reset(self) -> None:
        self._tail = np.zeros(0, dtype=np.int16)               # leftover < one frame
        self._started = False
        self._collected: list[np.ndarray] = []
        self._prebuffer: list[np.ndarray] = []
        self._silence_run = 0
        self._frames_since_start = 0

    def feed(self, chunk_int16: np.ndarray) -> Optional[np.ndarray]:
        self._tail = np.concatenate([self._tail, chunk_int16])
        while len(self._tail) >= self._frame:
            frame = self._tail[:self._frame]
            self._tail = self._tail[self._frame:]
            result = self._process_frame(frame)
            if result is not None:
                return result
        return None

    def _process_frame(self, frame: np.ndarray) -> Optional[np.ndarray]:
        is_speech = self._vad.is_speech(frame.tobytes(), self._rate)
        if not self._started:
            self._prebuffer.append(frame)
            if len(self._prebuffer) > self._prebuffer_frames:
                self._prebuffer.pop(0)
            if is_speech:
                self._started = True
                self._collected = list(self._prebuffer)
                self._prebuffer = []
                self._frames_since_start = len(self._collected)
                self._silence_run = 0
            return None

        self._collected.append(frame)
        self._frames_since_start += 1
        self._silence_run = 0 if is_speech else self._silence_run + 1

        if self._silence_run >= self._silence_frames or self._frames_since_start >= self._max_frames:
            utterance = np.concatenate(self._collected) if self._collected else np.zeros(0, dtype=np.int16)
            self.reset()
            return utterance
        return None
