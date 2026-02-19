#!/usr/bin/env python3
"""
Voice reference recorder
========================
Captures audio from the Raspberry Pi's UDP mic stream,
saves it as a WAV reference file for XTTS v2 voice cloning.

Usage:
  python3 src/record_voice.py              # records 10s → assets/my_voice.wav
  python3 src/record_voice.py 15           # records 15s
  python3 src/record_voice.py 10 /tmp/ref.wav  # custom output path

The saved file is automatically used by voice_pipeline.py when
TTS_ENGINE=xtts and XTTS_SPEAKER_WAV points to it.

Note: stop the voice pipeline before recording (it uses the same UDP port).
"""

import io, os, socket, sys, time
import numpy as np
import soundfile as sf
from scipy import signal as scipy_signal

UDP_PORT    = int(os.getenv("VOICE_UDP_PORT", "5002"))
SAMPLE_RATE = 48_000   # Pi streams at 48kHz
SAMPLE_WIDTH = 2       # int16

DURATION    = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
OUT_PATH    = sys.argv[2] if len(sys.argv) > 2 else "assets/my_voice.wav"
OUT_RATE    = 22050    # XTTS v2 expects ≥22050 Hz for best quality

os.makedirs(os.path.dirname(OUT_PATH) if os.path.dirname(OUT_PATH) else ".", exist_ok=True)

print(f"Recording {DURATION}s from UDP :{UDP_PORT}…  Speak now!")
print("(Stop the voice pipeline first if it's running)")

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
sock.bind(("0.0.0.0", UDP_PORT))
sock.settimeout(0.5)

buf = b""
start = time.time()
while time.time() - start < DURATION:
    remaining = DURATION - (time.time() - start)
    print(f"\r  {remaining:.0f}s remaining…", end="", flush=True)
    try:
        data, _ = sock.recvfrom(65535)
        buf += data
    except socket.timeout:
        pass

sock.close()
print(f"\nCaptured {len(buf)/SAMPLE_RATE/SAMPLE_WIDTH:.1f}s of audio")

# Convert to float32 and resample to OUT_RATE
samples = np.frombuffer(buf, dtype=np.int16).astype(np.float32) / 32768.0
resampled = scipy_signal.resample_poly(
    samples,
    OUT_RATE,
    SAMPLE_RATE,
).astype(np.float32)

sf.write(OUT_PATH, resampled, OUT_RATE)
print(f"Saved → {OUT_PATH}  ({len(resampled)/OUT_RATE:.1f}s @ {OUT_RATE}Hz)")
print()
print("To use your voice, set these env vars and restart the pipeline:")
print(f"  TTS_ENGINE=xtts  XTTS_SPEAKER_WAV={OUT_PATH}  npm run voice")
