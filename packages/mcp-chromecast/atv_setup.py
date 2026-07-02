#!/usr/bin/env python3
"""
atv_setup.py — appairage Android TV Remote pour lancer des apps sur la Google TV
(utilisé par le tool cast_dashboard pour lancer Fully). Génère + appaire un
cert/clé et les écrit dans data/state/. À lancer une seule fois par machine.

  npm run setup:atv        (depuis la racine)

Résout le dossier data comme le reste du projet : YUI_DATA_DIR, sinon <racine>/data
(indépendant du cwd — npm -w lance ce script depuis le dossier du package).
"""
import asyncio
import os
import sys

from androidtvremote2 import AndroidTVRemote

HOST = os.environ.get("CHROMECAST_HOST", "10.0.0.140")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("YUI_DATA_DIR") or os.path.join(
    SCRIPT_DIR, "..", "..", "data"
)
STATE = os.path.abspath(os.path.join(DATA_DIR, "state"))
CERT = os.path.join(STATE, "atv-cert.pem")
KEY = os.path.join(STATE, "atv-key.pem")


async def _connect_ok() -> bool:
    """True si un cert/clé déjà appairé fonctionne."""
    if not (os.path.exists(CERT) and os.path.exists(KEY)):
        return False
    remote = AndroidTVRemote("Yui", CERT, KEY, HOST)
    try:
        await asyncio.wait_for(remote.async_connect(), timeout=10)
        remote.disconnect()
        return True
    except Exception:
        return False


async def main() -> int:
    os.makedirs(STATE, exist_ok=True)
    print(f"=== Yui — Setup Android TV Remote (host {HOST}) ===")
    print(f"    cert/clé → {STATE}")

    if await _connect_ok():
        print("Déjà appairé et fonctionnel ✓ — rien à faire.")
        return 0

    remote = AndroidTVRemote("Yui", CERT, KEY, HOST)
    await remote.async_generate_cert_if_missing()
    try:
        name, mac = await remote.async_get_name_and_mac()
        print(f"Appareil détecté : {name} ({mac})")
    except Exception as exc:
        print(f"Impossible de joindre la TV sur {HOST} : {exc}", file=sys.stderr)
        print("Vérifie que la Google TV est allumée et sur le réseau.", file=sys.stderr)
        return 1

    await remote.async_start_pairing()
    print("\nUn code d'appairage à 6 caractères s'affiche maintenant sur la TV.")
    code = input("Entre le code affiché : ").strip()
    try:
        await remote.async_finish_pairing(code)
    except Exception as exc:
        print(f"Appairage échoué : {exc}", file=sys.stderr)
        return 1

    try:
        os.chmod(KEY, 0o600)
    except OSError:
        pass
    print("\nAppairage réussi ✓ — cert/clé écrits. Fully sera lançable via cast_dashboard.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
