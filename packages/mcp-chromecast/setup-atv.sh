#!/usr/bin/env bash
# Setup Android TV Remote (lib + appairage) pour mcp-chromecast.
# Idempotent : installe androidtvremote2 puis lance l'appairage (skip si déjà OK).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== Installation de androidtvremote2 (python3) =="
# --break-system-packages requis sur les distros PEP 668 (Ubuntu 24.04…) ;
# on tente d'abord sans, puis avec en repli.
python3 -m pip install --user androidtvremote2 >/dev/null 2>&1 \
  || python3 -m pip install --user --break-system-packages androidtvremote2

echo "== Appairage Android TV Remote =="
exec python3 "$HERE/atv_setup.py"
