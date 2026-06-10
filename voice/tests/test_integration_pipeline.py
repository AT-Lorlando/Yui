import glob, os, wave
import numpy as np
import pytest
from audio_source import AudioSource
from wake import WakeDetector, OWW_CHUNK
from vad_capture import UtteranceCapture

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODEL = os.path.join(ROOT, "assets", "wakeword", "yui.onnx")
POS = os.path.join(ROOT, "assets", "wakeword", "samples", "yui", "positive")

class FakeVad:
    def is_speech(self, frame_bytes, rate):
        a = np.frombuffer(frame_bytes, dtype=np.int16)
        return bool(np.abs(a.astype(np.int32)).mean() > 80)

def _load(path):
    with wave.open(path, "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)

@pytest.mark.skipif(not os.path.isfile(MODEL), reason="yui.onnx not present")
def test_push_positive_sample_triggers_wake_and_capture():
    src = AudioSource(port=0, get_gain=lambda: 1.0)
    det = WakeDetector(MODEL)
    cap = UtteranceCapture(FakeVad(), silence_ms=300, max_ms=4000, prebuffer_ms=0)

    pcm = _load(sorted(glob.glob(os.path.join(POS, "*.wav")))[0])
    pcm = np.concatenate([pcm, np.zeros(16000, dtype=np.int16)])
    src._push(pcm.tobytes())

    fired = False
    utterance = None
    for _ in range(len(pcm) // OWW_CHUNK):
        chunk = src.read(OWW_CHUNK)
        if not fired and det.score(chunk) >= 0.5:
            fired = True
            cap.reset()
        if fired:
            utterance = cap.feed(chunk)
            if utterance is not None:
                break
    assert fired, "wake word did not trigger on a positive sample"
    assert utterance is not None and len(utterance) > 0
