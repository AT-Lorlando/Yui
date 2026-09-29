#!/usr/bin/env bash
# Déplace l'APK debug fraîchement construit vers le dossier servi par
# `GET /downloads` (YUI_DOWNLOAD_DIR, défaut /share/yui_download), horodaté
# pour que chaque build reste identifiable sur le téléphone.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
DEST_DIR="${YUI_DOWNLOAD_DIR:-/share/yui_download}"
[ -f "$SRC" ] || { echo "APK introuvable : $SRC (lancer build:apk d'abord)" >&2; exit 1; }
mkdir -p "$DEST_DIR"
NAME="yui-$(date +%Y%m%d-%H%M).apk"
mv "$SRC" "$DEST_DIR/$NAME"
echo "APK → $DEST_DIR/$NAME"
echo "Téléchargement : http://$(hostname -I 2>/dev/null | awk '{print $1}'):${ORCHESTRATOR_PORT:-4000}/downloads/$NAME"
