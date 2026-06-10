import numpy as np
from audio_source import AudioSource

def test_push_then_read_returns_samples():
    src = AudioSource(port=0, get_gain=lambda: 1.0)
    src._push((np.arange(2560, dtype=np.int16)).tobytes())
    out = src.read(1280)
    assert len(out) == 1280
    assert out[0] == 0 and out[1] == 1

def test_gain_is_applied_and_clipped():
    src = AudioSource(port=0, get_gain=lambda: 2.0)
    src._push(np.array([100, -100, 20000], dtype=np.int16).tobytes())
    out = src.read(3)
    assert out[0] == 200 and out[1] == -200
    assert out[2] == 32767

def test_read_blocks_until_enough():
    import threading, time
    src = AudioSource(port=0, get_gain=lambda: 1.0)
    result = {}
    def reader():
        result["data"] = src.read(1280)
    t = threading.Thread(target=reader); t.start()
    time.sleep(0.1)
    assert not result
    src._push(np.ones(1280, dtype=np.int16).tobytes())
    t.join(timeout=2)
    assert len(result["data"]) == 1280
