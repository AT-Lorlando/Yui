#!/usr/bin/env python3
"""
Génère les fichiers WAV de confirmation vocale pour Yui.
Appelle le serveur XTTS local pour synthétiser chaque phrase,
et sauvegarde les fichiers dans assets/chimes/.

Usage:
    python scripts/generate_chimes.py [--speaker "Nom"] [--speed 1.15]

Le serveur yui-tts-engine doit être démarré avant de lancer ce script.
"""
import argparse
import os
import sys
import time

import requests

XTTS_URL = os.getenv("XTTS_SERVER_URL", "http://localhost:18770/tts")
OUT_DIR   = os.path.join(os.path.dirname(__file__), "..", "assets", "chimes")

PHRASES = [
    "Yep.",
    "Ok.",
    "Je fais ça.",
    "D'accord.",
    "Bien sûr.",
    "Je m'en occupe.",
    "Compris.",
    "Tout de suite.",
    "C'est noté.",
    "Ça marche.",
    "Nickel.",
    "Je vois ça.",
    "Parfait.",
    "Allez.",
    "J'arrive.",
    "Sur le coup.",
    "Voilà.",
    "Je check ça.",
    "Mmh, ok.",
    "Reçu.",
]


def wait_for_server(url: str, timeout: int = 30) -> bool:
    health = url.replace("/tts", "/health")
    print(f"Attente du serveur TTS ({health})…")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(health, timeout=2)
            if r.status_code == 200:
                print("Serveur prêt.")
                return True
        except requests.ConnectionError:
            pass
        time.sleep(2)
    return False


def generate(phrase: str, speaker: str, speed: float) -> bytes:
    resp = requests.post(
        XTTS_URL,
        json={"text": phrase, "language": "fr", "speaker": speaker, "speed": speed},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.content


def main() -> None:
    parser = argparse.ArgumentParser(description="Génère les chimes WAV pour Yui")
    parser.add_argument("--speaker", default="Ana Florence", help="Voix XTTS")
    parser.add_argument("--speed",   type=float, default=1.15, help="Vitesse TTS")
    parser.add_argument("--force",   action="store_true", help="Regénère même si le fichier existe")
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    if not wait_for_server(XTTS_URL):
        print("Serveur TTS inaccessible. Lance d'abord yui-tts-engine.", file=sys.stderr)
        sys.exit(1)

    print(f"Génération de {len(PHRASES)} phrases (speaker={args.speaker!r}, speed={args.speed})…\n")

    for i, phrase in enumerate(PHRASES, 1):
        slug = phrase.lower().rstrip(".").replace(" ", "_").replace(",", "").replace("'", "")
        path = os.path.join(OUT_DIR, f"{i:02d}_{slug}.wav")

        if os.path.exists(path) and not args.force:
            print(f"  [{i:02d}/{len(PHRASES)}] ⏭  {phrase!r} (déjà généré)")
            continue

        try:
            wav = generate(phrase, args.speaker, args.speed)
            with open(path, "wb") as f:
                f.write(wav)
            print(f"  [{i:02d}/{len(PHRASES)}] ✓  {phrase!r} → {os.path.basename(path)} ({len(wav)//1024} KB)")
        except Exception as e:
            print(f"  [{i:02d}/{len(PHRASES)}] ✗  {phrase!r} — {e}", file=sys.stderr)

    wavs = [f for f in os.listdir(OUT_DIR) if f.endswith(".wav")]
    print(f"\n{len(wavs)} fichier(s) dans {OUT_DIR}")


if __name__ == "__main__":
    main()
