import json
from tuning import VoiceTuning, load_tuning, save_tuning

def test_defaults():
    t = VoiceTuning()
    assert t.threshold == 0.5
    assert t.vad_aggressiveness == 2
    assert t.gain == 1.0

def test_save_then_load_roundtrip(tmp_path):
    p = tmp_path / "voice-tuning.json"
    save_tuning(VoiceTuning(threshold=0.7, vad_aggressiveness=3, gain=2.0), str(p))
    loaded = load_tuning(str(p))
    assert (loaded.threshold, loaded.vad_aggressiveness, loaded.gain) == (0.7, 3, 2.0)

def test_load_missing_file_returns_defaults(tmp_path):
    loaded = load_tuning(str(tmp_path / "nope.json"))
    assert loaded.threshold == 0.5

def test_update_clamps(tmp_path):
    t = VoiceTuning()
    t.update(threshold=5.0, vad_aggressiveness=99, gain=-1.0)
    assert t.threshold == 1.0
    assert t.vad_aggressiveness == 3
    assert t.gain == 0.0
