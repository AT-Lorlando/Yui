#!/usr/bin/env bash
# Source voice/.env puis lance le serveur XTTS dans le venv xtts.
set -e
cd "$(dirname "$0")"            # voice/
set -a; source ./.env; set +a
exec /home/chuya/.venvs/xtts/bin/python tts_engine.py
