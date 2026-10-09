#!/usr/bin/env bash
# Charge voice/.env (env.sh, sans évaluation shell) puis lance le serveur XTTS dans son venv (voice/.venv-xtts, ou XTTS_VENV).
set -e
cd "$(dirname "$0")"            # voice/
source ./env.sh && load_env ./.env
source ./pyenv.sh
PY="$(voice_python "${XTTS_VENV:-$PWD/.venv-xtts}" python3.11)"
exec "$PY" tts_engine.py
