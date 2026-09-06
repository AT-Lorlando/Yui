#!/usr/bin/env bash
# OAuth librespot (une fois) : remplit data/shared/librespot/credentials.json.
# Nécessaire pour que le streamer (lecture Spotify sur les enceintes Google
# Home via cast) puisse s'enregistrer comme device Spotify Connect.
set -euo pipefail
cd "$(dirname "$0")/.."
CACHE="${LIBRESPOT_CACHE:-$PWD/data/shared/librespot}"
mkdir -p "$CACHE"
echo "→ Un lien d'autorisation Spotify va s'afficher : ouvre-le dans un navigateur"
echo "  SUR CETTE MACHINE (la redirection revient sur 127.0.0.1)."
exec librespot --name "Yui-Seeder" --backend pipe --enable-oauth --cache "$CACHE" --disable-audio-cache
