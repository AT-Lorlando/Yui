#!/usr/bin/env python3
"""
Validate the OpenWakeWord streaming inference chain against the training samples.

Runs on the dev machine (needs openwakeword + onnxruntime installed).
Loads assets/wakeword/yui.onnx, scores every clip in
assets/wakeword/samples/yui/{positive,negative}/ using the SAME feature chain
the satellite uses at runtime, and reports separation at the default threshold.

Exit code 0 if positives mean > negatives mean AND threshold 0.5 separates
at least 80% of each class; non-zero otherwise.

Usage:
    python scripts/test_wakeword_inference.py
    python scripts/test_wakeword_inference.py --threshold 0.5
"""
import argparse
import glob
import os
import sys
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, "assets", "wakeword", "yui.onnx")
POS_GLOB = os.path.join(ROOT, "assets", "wakeword", "samples", "yui", "positive", "*.wav")
NEG_GLOB = os.path.join(ROOT, "assets", "wakeword", "samples", "yui", "negative", "*.wav")

CHUNK = 1280            # OWW standard chunk (80 ms @ 16 kHz)
N_FRAMES = 16           # embedding frames per inference window (≈ 2 s)
ONNX_INPUT = "x.1"
ONNX_OUTPUT = "53"


def load_wav(path):
    with wave.open(path, "rb") as wf:
        return np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)


def score_clip(audio, session, audio_features_cls):
    af = audio_features_cls()
    for i in range(0, len(audio) - CHUNK + 1, CHUNK):
        af(audio[i:i + CHUNK])
    feats = af.get_features(N_FRAMES).astype(np.float32)  # (1, 16, 96)
    out = session.run([ONNX_OUTPUT], {ONNX_INPUT: feats})[0]
    return float(np.array(out).flatten()[0])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=0.5)
    args = parser.parse_args()

    import onnxruntime as ort
    from openwakeword.utils import AudioFeatures

    session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])

    pos = [score_clip(load_wav(p), session, AudioFeatures) for p in sorted(glob.glob(POS_GLOB))]
    neg = [score_clip(load_wav(p), session, AudioFeatures) for p in sorted(glob.glob(NEG_GLOB))]

    if not pos or not neg:
        print("ERROR: no samples found")
        sys.exit(2)

    pos_arr, neg_arr = np.array(pos), np.array(neg)
    pos_hit = float((pos_arr >= args.threshold).mean())
    neg_rej = float((neg_arr < args.threshold).mean())

    print(f"threshold = {args.threshold}")
    print(f"positives: n={len(pos)} mean={pos_arr.mean():.3f} "
          f"min={pos_arr.min():.3f} hit_rate={pos_hit:.0%}")
    print(f"negatives: n={len(neg)} mean={neg_arr.mean():.3f} "
          f"max={neg_arr.max():.3f} reject_rate={neg_rej:.0%}")

    ok = pos_arr.mean() > neg_arr.mean() and pos_hit >= 0.80 and neg_rej >= 0.80
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
