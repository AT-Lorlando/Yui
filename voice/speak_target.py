"""Enceinte cible d'un POST /speak (pur, testable sans réseau)."""
from __future__ import annotations


def speak_target(body: dict, default: str) -> str | None:
    """Nom d'enceinte demandé s'il diffère (casse ignorée) de `default`,
    sinon None (= enceinte principale)."""
    dev = body.get("device")
    if not isinstance(dev, str):
        return None
    dev = dev.strip()
    if not dev or dev.lower() == default.lower():
        return None
    return dev
