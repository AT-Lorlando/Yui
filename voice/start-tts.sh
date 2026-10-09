#!/usr/bin/env bash
# Charge voice/.env (env.sh, sans évaluation shell) puis lance le serveur XTTS dans le venv xtts.
set -e
cd "$(dirname "$0")"            # voice/
source ./env.sh && load_env ./.env
exec /home/chuya/.venvs/xtts/bin/python tts_engine.py
