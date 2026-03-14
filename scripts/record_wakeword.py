#!/usr/bin/env python3
"""
Interactive recording script for OpenWakeWord training data.

Captures audio from the Raspberry Pi UDP stream (same path as the voice pipeline)
so that training samples match real inference conditions.

Requires the Pi's udp_stream.py to be running.

Usage:
    python scripts/record_wakeword.py
    WAKEWORD_NAME=aria python scripts/record_wakeword.py
"""
import os
import sys
import socket
import wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Load .env
_env_path = os.path.join(ROOT, ".env")
if os.path.isfile(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

WAKEWORD_NAME = os.getenv("WAKEWORD_NAME", "yui")
SAMPLES_DIR   = os.path.join(ROOT, "assets", "wakeword", "samples", WAKEWORD_NAME)
POSITIVE_DIR  = os.path.join(SAMPLES_DIR, "positive")
NEGATIVE_DIR  = os.path.join(SAMPLES_DIR, "negative")

SAMPLE_RATE   = 16_000
SAMPLE_WIDTH  = 2           # int16
CLIP_DURATION = 2.0         # seconds
CLIP_BYTES    = int(SAMPLE_RATE * SAMPLE_WIDTH * CLIP_DURATION)  # 64 000 bytes
UDP_PORT      = int(os.getenv("VOICE_UDP_PORT", "5002"))

NEGATIVE_HINTS = {
    "yui":   '"oui", "lui", "nuit", "bruit", "fruit", "je suis", "la pluie", "gratuit", "Louis"',
    "lunix": '"Linux", "Louis", "Lucie", "lumineux", "lundi"',
}


def count(directory: str) -> int:
    if not os.path.isdir(directory):
        return 0
    return len([f for f in os.listdir(directory) if f.endswith(".wav")])


def record_clip_udp() -> np.ndarray:
    """
    Capture exactly 2 seconds of raw s16le audio from the UDP stream.
    Reads raw bytes arriving from ffmpeg on the Pi — same chain as pipeline.py.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", UDP_PORT))
    sock.settimeout(5.0)

    buf = b""
    try:
        while len(buf) < CLIP_BYTES:
            chunk, _ = sock.recvfrom(65536)
            buf += chunk
    except socket.timeout:
        print("\n  TIMEOUT — le flux UDP n'arrive pas.")
        print(f"  Vérifie que udp_stream.py tourne sur le Pi (port {UDP_PORT}).")
        sock.close()
        return None
    finally:
        sock.close()

    raw = buf[:CLIP_BYTES]
    return np.frombuffer(raw, dtype=np.int16).copy()


def save_wav(audio: np.ndarray, directory: str, prefix: str) -> str:
    os.makedirs(directory, exist_ok=True)
    idx  = count(directory) + 1
    path = os.path.join(directory, f"{prefix}_{idx:03d}.wav")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio.tobytes())
    return path


def play_back(audio: np.ndarray) -> None:
    try:
        import sounddevice as sd
        sd.play(audio.astype(np.float32) / 32768.0, samplerate=SAMPLE_RATE)
        sd.wait()
    except Exception:
        pass


def wait_for_stream() -> bool:
    """Check that UDP packets are arriving before starting."""
    print(f"  Vérification du flux UDP sur le port {UDP_PORT}...", end="", flush=True)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", UDP_PORT))
    sock.settimeout(3.0)
    try:
        sock.recvfrom(1024)
        print(" OK")
        return True
    except socket.timeout:
        print(" ABSENT")
        return False
    finally:
        sock.close()


def record_session(label: str, directory: str, prefix: str,
                   target: int, prompt: str) -> None:
    print(f"\n{'─'*50}")
    print(f"  {label}")
    print(f"  Objectif : {target} clips")
    existing = count(directory)
    if existing >= target:
        print(f"  Déjà {existing} fichiers — objectif atteint !")
        if input("  Ajouter quand même ? (o/N) ").strip().lower() != "o":
            return
    print(f"{'─'*50}")

    while True:
        current   = count(directory)
        remaining = max(0, target - current)
        print(f"\n  [{current} enregistrés | {remaining} restants pour {target}]")

        if current >= target:
            if input("  Objectif atteint ! Continuer ? (o/N) ").strip().lower() != "o":
                break

        print(f"\n  {prompt}")
        print(f"  → Appuie sur Entrée, puis parle immédiatement ({CLIP_DURATION:.0f}s capturées)")
        input("  [Entrée] ")

        print("  ● CAPTURE...", end="", flush=True)
        audio = record_clip_udp()
        if audio is None:
            continue
        print(" OK")

        if input("  Écouter ? (o/N) ").strip().lower() == "o":
            play_back(audio)

        if input("  Garder ? (O/n) ").strip().lower() != "n":
            path = save_wav(audio, directory, prefix)
            print(f"  Sauvegardé : {os.path.basename(path)}")
        else:
            print("  Ignoré.")

        if input("  Continuer ? (O/n) ").strip().lower() == "n":
            break


def main() -> None:
    name_upper = WAKEWORD_NAME.capitalize()
    hints = NEGATIVE_HINTS.get(WAKEWORD_NAME.lower(), "mots phonétiquement proches")

    print(f"Enregistrement wake word — « {name_upper} »")
    print("=" * 50)
    print(f"""
  Source audio : flux UDP du Raspberry Pi (port {UDP_PORT})
  Samples      : {os.path.relpath(SAMPLES_DIR, ROOT)}

  L'audio est capturé via le même chemin qu'en production :
    Pi micro → ffmpeg 16kHz → UDP → ce script

  POSITIFS : dis « {name_upper} » dans les 2s après l'Entrée
  NÉGATIFS : tout sauf « {name_upper} »
             Priorité : {hints}
             Puis : parole normale, silence, bruit de fond

  Conseils :
    - Varie la distance (30 cm / 1 m / 2 m)
    - Varie le ton (normal, fatigué, enthousiaste, chuchoté)
    - Quelques clips avec TV ou musique en fond
""")

    if not wait_for_stream():
        print(f"""
  Le flux UDP n'est pas détecté.
  Vérifie que le Pi streame bien :
    ssh pi 'ps aux | grep udp_stream'
    ssh pi 'setsid python3 ~/udp_stream.py > /tmp/udp.log 2>&1 &'
""")
        if input("  Continuer quand même ? (o/N) ").strip().lower() != "o":
            sys.exit(1)

    input("\n  Appuie sur Entrée pour commencer... ")

    record_session(
        label    = f"POSITIFS — dis « {name_upper} »",
        directory= POSITIVE_DIR,
        prefix   = WAKEWORD_NAME.lower(),
        target   = 50,
        prompt   = f"Dis « {name_upper} » clairement",
    )

    print(f"""
  Maintenant les NÉGATIFS.
  Dis n'importe quoi SAUF « {name_upper} » :
    - Mots similaires : {hints}
    - Lis un texte à voix haute (2s à la fois)
    - Silence
    - TV / musique en fond
""")

    record_session(
        label    = f"NÉGATIFS — tout sauf « {name_upper} »",
        directory= NEGATIVE_DIR,
        prefix   = "neg",
        target   = 50,
        prompt   = f"Parle / fais du bruit (pas « {name_upper} »)",
    )

    print(f"""
  Terminé !
  Positifs : {count(POSITIVE_DIR)} clips
  Négatifs : {count(NEGATIVE_DIR)} clips

  Lance l'entraînement :
    python scripts/train_wakeword.py
""")


if __name__ == "__main__":
    main()
