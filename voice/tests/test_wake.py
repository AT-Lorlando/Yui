import glob, os, wave
import numpy as np
import pytest
from wake import WakeDetector, OWW_CHUNK

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODEL = os.path.join(ROOT, "assets", "wakeword", "yui.onnx")
POS = os.path.join(ROOT, "assets", "wakeword", "samples", "yui", "positive")
NEG = os.path.join(ROOT, "assets", "wakeword", "samples", "yui", "negative")

def _load(path):
    with wave.open(path, "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)

def _max_score(det, pcm):
    det.reset()
    best = 0.0
    for i in range(0, len(pcm) - OWW_CHUNK, OWW_CHUNK):
        best = max(best, det.score(pcm[i:i+OWW_CHUNK]))
    return best

@pytest.mark.skipif(not os.path.isfile(MODEL), reason="yui.onnx not present")
def test_positive_samples_score_high():
    det = WakeDetector(MODEL)
    files = sorted(glob.glob(os.path.join(POS, "*.wav")))[:10]
    scores = [_max_score(det, _load(f)) for f in files]
    assert np.mean(scores) > 0.8

@pytest.mark.skipif(not os.path.isfile(MODEL), reason="yui.onnx not present")
def test_reset_then_silence_scores_low():
    det = WakeDetector(MODEL)
    det.reset()
    silence = np.zeros(OWW_CHUNK, dtype=np.int16)
    last = 0.0
    for _ in range(20):
        last = det.score(silence)
    assert last < 0.3
