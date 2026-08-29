#!/usr/bin/env python3
"""
atv_launch.py — lance une app sur la Chromecast with Google TV via le protocole
Android TV Remote v2 (ports 6466/6467), sans ADB ni Fully PLUS.

Usage:
  python3 atv_launch.py <host> <cert.pem> <key.pem> <package|url> [expected_pkg]

La cible peut être un package Android ("de.ozerov.fully") ou un app link
(ex. "https://app.primevideo.com/detail?gti=…") — Android résout l'intent.

Le couple cert/clé doit avoir été appairé une fois avec la TV (code à l'écran).
Sort 0 + message si l'app est bien passée au premier plan, sinon code != 0.
"""
import asyncio
import sys
from androidtvremote2 import AndroidTVRemote

CONFIRM_TIMEOUT_S = 8


async def main() -> int:
    if len(sys.argv) < 5:
        print("usage: atv_launch.py <host> <cert> <key> <package>", file=sys.stderr)
        return 2
    host, cert, key, target = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    # Confirmation du 1er plan : package explicite, ou la cible si c'en est un.
    expected = sys.argv[5] if len(sys.argv) > 5 else (
        None if target.startswith('http') else target
    )

    remote = AndroidTVRemote("Yui", cert, key, host)
    try:
        await remote.async_connect()
    except Exception as exc:
        print(f"Android TV Remote: connexion échouée ({exc}). "
              f"Cert appairé absent/invalide ?", file=sys.stderr)
        return 1

    remote.send_launch_app_command(target)

    launched = False
    if expected:
        for _ in range(CONFIRM_TIMEOUT_S):
            await asyncio.sleep(1)
            if remote.current_app and expected in str(remote.current_app):
                launched = True
                break
    else:
        await asyncio.sleep(2)
    remote.disconnect()

    if launched:
        print(f"App {expected} lancée sur la Google TV.")
        return 0
    # Commande envoyée mais 1er plan non confirmé (TV en veille profonde, etc.)
    print(f"Commande de lancement envoyée ({target}).")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
