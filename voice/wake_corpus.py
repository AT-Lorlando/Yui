"""Étiquetage des wakes enregistrés → corpus d'entraînement.

La page /debug archive chaque wake en WAV (data/voice-debug/wakes/). Deux
boutons par entrée : « vrai wake » copie le WAV dans
assets/wakeword/samples/<name>/positive/ (des positifs avec la VRAIE
acoustique de la pièce), « faux wake » le déplace dans negative/. Le script
scripts/train_wakeword.py lit ces deux dossiers tel quel — ré-entraîner =
`python scripts/train_wakeword.py` puis `pm2 restart yui-voice`.
"""
from __future__ import annotations

import logging
import os
import shutil

from config import WAKEWORD_NAME

log = logging.getLogger("voice")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAKES_DIR = os.path.join(_ROOT, "data", "voice-debug", "wakes")
SAMPLES_DIR = os.path.join(_ROOT, "assets", "wakeword", "samples", WAKEWORD_NAME)


def label_wake(wav_url: str, label: str) -> bool:
    """Classe un wake archivé. `wav_url` = "/voice-debug/wakes/<file>.wav".

    - "positive" : copié dans le corpus positif (le WAV reste rejouable).
    - "false"    : déplacé dans le corpus négatif (retiré des wakes).
    """
    name = os.path.basename(wav_url)
    if not name.endswith(".wav") or "/" in name or name.startswith("."):
        return False
    src = os.path.join(WAKES_DIR, name)
    if not os.path.isfile(src):
        log.warning(f"wake_corpus: {name} introuvable")
        return False

    if label == "positive":
        dest_dir = os.path.join(SAMPLES_DIR, "positive")
        os.makedirs(dest_dir, exist_ok=True)
        shutil.copy2(src, os.path.join(dest_dir, name))
        log.info(f"wake_corpus: {name} → positif")
        return True
    if label == "false":
        dest_dir = os.path.join(SAMPLES_DIR, "negative")
        os.makedirs(dest_dir, exist_ok=True)
        shutil.move(src, os.path.join(dest_dir, name))
        log.info(f"wake_corpus: {name} → négatif (retiré des wakes)")
        return True
    return False


def corpus_counts() -> dict:
    """Tailles des corpus (affichées sur la page /debug)."""
    def count(sub: str) -> int:
        d = os.path.join(SAMPLES_DIR, sub)
        try:
            return len([f for f in os.listdir(d) if f.endswith(".wav")])
        except FileNotFoundError:
            return 0

    return {"positive": count("positive"), "negative": count("negative")}
