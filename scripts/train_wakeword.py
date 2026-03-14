#!/usr/bin/env python3
"""
Training script for OpenWakeWord-based wake word detector.

Wake word is read from WAKEWORD_NAME env var (default: yui).
Reads samples from assets/wakeword/samples/{name}/positive|negative/.
Exports model to assets/wakeword/{name}.onnx.

Usage:
    python scripts/train_wakeword.py
    WAKEWORD_NAME=aria python scripts/train_wakeword.py
"""

import os
import sys
import random
import wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Load .env if present
_env_path = os.path.join(ROOT, ".env")
if os.path.isfile(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

WAKEWORD_NAME = os.getenv("WAKEWORD_NAME", "yui")
SAMPLES_DIR  = os.path.join(ROOT, "assets", "wakeword", "samples", WAKEWORD_NAME)
POSITIVE_DIR = os.path.join(SAMPLES_DIR, "positive")
NEGATIVE_DIR = os.path.join(SAMPLES_DIR, "negative")
OUTPUT_PATH  = os.path.join(ROOT, "assets", "wakeword", f"{WAKEWORD_NAME}.onnx")

SAMPLE_RATE  = 16_000
CLIP_SAMPLES = 32_000   # 2 seconds — exactly 16 OWW embedding frames
AUG_FACTOR   = 8        # augmentations per real clip
EPOCHS       = 60
BATCH_SIZE   = 32
LR           = 1e-3


# ── Audio helpers ──────────────────────────────────────────────────────────────

def load_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if sr != SAMPLE_RATE:
        factor = SAMPLE_RATE / sr
        n_out  = int(len(audio) * factor)
        indices = np.round(np.linspace(0, len(audio) - 1, n_out)).astype(int)
        audio   = audio[indices]
    return audio.astype(np.int16)


def pad_or_trim(audio: np.ndarray, n: int = CLIP_SAMPLES) -> np.ndarray:
    if len(audio) >= n:
        return audio[:n]
    return np.pad(audio, (0, n - len(audio)))


def augment(audio: np.ndarray) -> list:
    clips = []
    f32 = audio.astype(np.float32)
    for _ in range(AUG_FACTOR):
        x = f32.copy()
        # Speed perturbation ±15% (simulates fast/slow speech)
        speed = random.uniform(0.85, 1.15)
        n_out = int(len(x) / speed)
        indices = np.round(np.linspace(0, len(x) - 1, n_out)).astype(int)
        x = x[indices]
        x = pad_or_trim(x.astype(np.int16)).astype(np.float32)
        # Volume ±20% (simulates mic distance)
        x *= random.uniform(0.80, 1.20)
        # Gaussian noise (simulates background noise)
        x += np.random.randn(len(x)).astype(np.float32) * random.uniform(0, 300)
        x = np.clip(x, -32768, 32767)
        clips.append(x.astype(np.int16))
    return clips


def load_directory(directory: str, augment_clips: bool) -> list:
    clips = []
    for fname in sorted(os.listdir(directory)):
        if not fname.endswith(".wav"):
            continue
        raw  = load_wav(os.path.join(directory, fname))
        clip = pad_or_trim(raw)
        clips.append(clip)
        if augment_clips:
            clips.extend(augment(clip))
    return clips


# ── OWW embedding ─────────────────────────────────────────────────────────────

def embed(clips: list):
    try:
        from openwakeword.utils import AudioFeatures
    except ImportError:
        print("ERROR: openwakeword not installed")
        print("  pip install openwakeword==0.4.0")
        sys.exit(1)

    af  = AudioFeatures()
    arr = np.stack(clips, axis=0)    # (N, 32000)
    emb = af.embed_clips(arr)        # (N, 16, 96)
    return emb.astype(np.float32)


# ── Model ─────────────────────────────────────────────────────────────────────

def build_model():
    import torch.nn as nn
    return nn.Sequential(
        nn.Flatten(),               # (B, 16, 96) → (B, 1536)
        nn.Linear(1536, 128),
        nn.ReLU(),
        nn.Dropout(0.3),
        nn.Linear(128, 32),
        nn.ReLU(),
        nn.Linear(32, 1),
        nn.Sigmoid(),
    )


def train(X: np.ndarray, y: np.ndarray):
    import torch
    import torch.nn as nn
    from torch.utils.data import TensorDataset, DataLoader

    Xt = torch.tensor(X, dtype=torch.float32)
    yt = torch.tensor(y, dtype=torch.float32).unsqueeze(1)

    loader  = DataLoader(TensorDataset(Xt, yt), batch_size=BATCH_SIZE, shuffle=True)
    model   = build_model()
    optim   = torch.optim.Adam(model.parameters(), lr=LR)
    loss_fn = nn.BCELoss()

    print(f"  {len(X)} samples, {EPOCHS} époques...")
    for epoch in range(1, EPOCHS + 1):
        model.train()
        total_loss, correct = 0.0, 0
        for xb, yb in loader:
            pred = model(xb)
            loss = loss_fn(pred, yb)
            optim.zero_grad()
            loss.backward()
            optim.step()
            total_loss += loss.item() * len(xb)
            correct    += ((pred > 0.5) == yb.bool()).sum().item()
        if epoch % 10 == 0 or epoch == 1:
            acc = correct / len(X) * 100
            print(f"  Époque {epoch:3d}/{EPOCHS}  loss={total_loss/len(X):.4f}  acc={acc:.1f}%")

    model.eval()
    return model


# ── ONNX export ───────────────────────────────────────────────────────────────

def export_onnx(model, output_path: str) -> None:
    import torch
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    dummy = torch.zeros(1, 16, 96, dtype=torch.float32)
    torch.onnx.export(
        model, dummy, output_path,
        input_names=["x.1"], output_names=["53"],
        opset_version=11,
        dynamic_axes={"x.1": {0: "batch"}},
    )
    print(f"  Modèle sauvegardé : {os.path.relpath(output_path, ROOT)}")


def verify_onnx(output_path: str) -> None:
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(output_path)
        dummy = np.zeros((1, 16, 96), dtype=np.float32)
        out   = sess.run(None, {"x.1": dummy})
        print(f"  Vérification ONNX OK — sortie dummy : {out[0][0][0]:.4f}")
    except ImportError:
        print("  (onnxruntime absent — vérification ignorée)")
    except Exception as e:
        print(f"  Vérification ONNX ÉCHOUÉE : {e}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    name_upper = WAKEWORD_NAME.capitalize()
    print(f"Entraînement wake word — « {name_upper} »")
    print("=" * 50)
    print(f"  WAKEWORD_NAME = {WAKEWORD_NAME}")
    print(f"  Samples      = {os.path.relpath(SAMPLES_DIR, ROOT)}")
    print(f"  Modèle ONNX  = {os.path.relpath(OUTPUT_PATH, ROOT)}")

    if not os.path.isdir(POSITIVE_DIR) or not os.path.isdir(NEGATIVE_DIR):
        print("\nERREUR : dossiers d'échantillons manquants.")
        print("  Lance d'abord : python scripts/record_wakeword.py")
        sys.exit(1)

    print("\n  Chargement des échantillons...")
    pos_clips = load_directory(POSITIVE_DIR, augment_clips=True)
    neg_clips = load_directory(NEGATIVE_DIR, augment_clips=True)

    if not pos_clips or not neg_clips:
        print("ERREUR : aucun fichier WAV trouvé.")
        sys.exit(1)

    n_pos_raw = len(pos_clips) // (AUG_FACTOR + 1)
    n_neg_raw = len(neg_clips) // (AUG_FACTOR + 1)
    print(f"  Positifs : {n_pos_raw} clips × {AUG_FACTOR+1} = {len(pos_clips)} total")
    print(f"  Négatifs : {n_neg_raw} clips × {AUG_FACTOR+1} = {len(neg_clips)} total")

    print("\n  Calcul des embeddings OWW...")
    all_clips = pos_clips + neg_clips
    labels    = np.array([1.0] * len(pos_clips) + [0.0] * len(neg_clips))
    X = embed(all_clips)
    print(f"  Shape embeddings : {X.shape}")

    idx = np.random.permutation(len(X))
    X, labels = X[idx], labels[idx]

    print("\n  Entraînement du MLP...")
    model = train(X, labels)

    print("\n  Export ONNX...")
    export_onnx(model, OUTPUT_PATH)
    verify_onnx(OUTPUT_PATH)

    print(f"""
  Terminé !
  Redémarre le pipeline pour activer le modèle :
    pm2 restart yui-voice
""")


if __name__ == "__main__":
    main()
