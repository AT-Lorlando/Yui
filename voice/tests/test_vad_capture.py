import numpy as np
from vad_capture import UtteranceCapture

class FakeVad:
    """is_speech returns True while non-zero samples are present in the frame."""
    def is_speech(self, frame_bytes, rate):
        a = np.frombuffer(frame_bytes, dtype=np.int16)
        return bool(np.abs(a).max() > 100)

def _chunk(value, n):
    return (np.ones(n, dtype=np.int16) * value)

def test_captures_speech_then_ends_on_silence():
    cap = UtteranceCapture(FakeVad(), silence_ms=300, max_ms=10000, prebuffer_ms=0)
    cap.reset()
    out = None
    for _ in range(13):
        out = cap.feed(_chunk(500, 1280))
        assert out is None
    for _ in range(10):
        out = cap.feed(_chunk(0, 1280))
        if out is not None:
            break
    assert out is not None
    assert np.abs(out).max() > 100
    assert len(out) > 16000 * 0.8

def test_waits_for_onset_in_silence():
    cap = UtteranceCapture(FakeVad(), silence_ms=300, max_ms=10000, prebuffer_ms=0)
    cap.reset()
    for _ in range(20):
        assert cap.feed(_chunk(0, 1280)) is None

def test_max_duration_forces_end():
    cap = UtteranceCapture(FakeVad(), silence_ms=2000, max_ms=500, prebuffer_ms=0)
    cap.reset()
    out = None
    for _ in range(20):
        out = cap.feed(_chunk(500, 1280))
        if out is not None:
            break
    assert out is not None
