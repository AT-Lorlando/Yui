"""Vocabulaire domotique dynamique pour Whisper.

L'`initial_prompt` statique aide déjà, mais les noms PROPRES du foyer (scènes,
effets, pièces, lampes) changent avec la config — « Mentalist », « Aurora »,
« WiiM » se faisaient massacrer à la transcription. Ce module interroge
l'orchestrateur au démarrage puis toutes les VOCAB_REFRESH_S secondes, et
construit un prompt court : base statique + noms du foyer.

Best-effort : orchestrateur injoignable → prompt statique seul.
"""
from __future__ import annotations

import logging
import os
import threading

import requests

from config import BEARER_TOKEN, WHISPER_PROMPT, YUI_URL

log = logging.getLogger("voice")

VOCAB_REFRESH_S = int(os.getenv("VOCAB_REFRESH_S", "600"))
# Whisper tronque les prompts longs (224 tokens) et un prompt trop bavard
# biaise la transcription — on borne large mais court.
MAX_VOCAB_CHARS = int(os.getenv("VOCAB_MAX_CHARS", "300"))

_BASE_URL = YUI_URL.rsplit("/", 1)[0]  # http://host:4000
_HEADERS = {"Authorization": f"Bearer {BEARER_TOKEN}"}

_lock = threading.Lock()
_vocab_words: list[str] = []


def build_prompt(base: str, words: list[str], max_chars: int = MAX_VOCAB_CHARS) -> str:
    """Assemble le prompt final. Pur (testé)."""
    if not words:
        return base
    seen: set[str] = set()
    uniq: list[str] = []
    for w in words:
        w = (w or "").strip()
        if not w or w.lower() in seen:
            continue
        seen.add(w.lower())
        uniq.append(w)
    suffix = ""
    for w in uniq:
        candidate = f"{suffix}, {w}" if suffix else w
        if len(candidate) > max_chars:
            break
        suffix = candidate
    return f"{base} Mots du foyer : {suffix}." if suffix else base


def _get_json(path: str):
    resp = requests.get(f"{_BASE_URL}{path}", headers=_HEADERS, timeout=5)
    resp.raise_for_status()
    return resp.json()


def refresh() -> None:
    """Recharge les noms du foyer depuis l'orchestrateur."""
    global _vocab_words
    words: list[str] = []
    try:
        for s in _get_json("/scenes"):
            words.append(s.get("name", ""))
    except Exception as e:
        log.debug(f"vocab: scènes indisponibles — {e}")
    try:
        for e_ in _get_json("/effects"):
            words.append(e_.get("name", ""))
    except Exception as e:
        log.debug(f"vocab: effets indisponibles — {e}")
    try:
        lights = _get_json("/devices/lights")
        rooms: list[str] = []
        for l in lights:
            room = l.get("room")
            if room and room not in rooms:
                rooms.append(room)
        words.extend(rooms)
        # Les noms de lampes adressables à la voix (« allume le lampadaire »)
        words.extend(l.get("name", "") for l in lights)
    except Exception as e:
        log.debug(f"vocab: lampes indisponibles — {e}")
    if words:
        with _lock:
            _vocab_words = words
        log.info(f"vocab: {len(words)} mot(s) du foyer chargés")


def get_prompt() -> str:
    with _lock:
        words = list(_vocab_words)
    return build_prompt(WHISPER_PROMPT, words)


def start_refresher() -> None:
    """Premier chargement + rafraîchissement périodique en arrière-plan."""

    def loop() -> None:
        while True:
            try:
                refresh()
            except Exception as e:
                log.warning(f"vocab refresh: {e}")
            import time as _t

            _t.sleep(VOCAB_REFRESH_S)

    threading.Thread(target=loop, daemon=True, name="vocab-refresh").start()
