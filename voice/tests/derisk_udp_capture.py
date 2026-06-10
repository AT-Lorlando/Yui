"""Capture a few seconds from the Pi UDP audio stream and score it through
yui.onnx, to confirm the ffmpeg-ALSA path is clean enough for OpenWakeWord.

Usage: say "Yui" a few times during the capture window, then read the score.
Note: the voice server's pipeline binds the same UDP port; stop yui-voice
before running this (otherwise the port is busy).
"""
import os, socket, time, wave
import numpy as np
from openwakeword.model import Model

PORT = int(os.getenv("AUDIO_UDP_PORT", "5002"))
SECS = 6
MODEL = os.path.join(os.path.dirname(__file__), "..", "..", "assets", "wakeword", "yui.onnx")


def main() -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", PORT))
    s.settimeout(2.0)
    print(f">>> SAY 'YUI' NOW — capturing {SECS}s from UDP:{PORT} <<<", flush=True)
    buf = bytearray()
    t0 = time.time()
    while time.time() - t0 < SECS:
        try:
            data, _ = s.recvfrom(65536)
        except socket.timeout:
            continue
        buf += data
    s.close()
    pcm = np.frombuffer(bytes(buf), dtype=np.int16)
    with wave.open("/tmp/derisk_udp.wav", "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm.tobytes())
    print(f"captured n={len(pcm)} peak={int(np.abs(pcm).max()) if len(pcm) else 0}")
    m = Model(wakeword_model_paths=[os.path.abspath(MODEL)])
    key = list(m.models.keys())[0]
    best = 0.0
    for i in range(0, len(pcm) - 1280, 1280):
        best = max(best, float(m.predict(pcm[i:i + 1280])[key]))
    print(f"yui max_score = {best:.3f}")


if __name__ == "__main__":
    main()
