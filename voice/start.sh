#!/usr/bin/env bash
# Charge voice/.env (env.sh, sans évaluation shell), attend XTTS + orchestrateur, puis lance le pipeline voix.
set -e
cd "$(dirname "$0")"            # voice/
source ./env.sh && load_env ./.env   # CUDA_VISIBLE_DEVICES posé avant torch
source ./pyenv.sh
PY="$(voice_python "${VOICE_VENV:-$PWD/.venv}" python3)"

# Logs JSON (convention homelab) : une ligne = un objet sur stdout.
log_json() {  # log_json <msg> <name>
    printf '{"time":%s,"level":"info","msg":"%s","app":"yui","service":"voice","env":"prod","detail":"%s"}\n' \
        "$(date +%s%3N)" "$1" "$2"
}

wait_for() {
    local name="$1"
    local url="$2"
    log_json "waiting for dependency" "$name"
    until curl -sf "$url" >/dev/null 2>&1; do
        sleep 3
    done
    log_json "dependency ready" "$name"
}

wait_for "XTTS server"  "http://localhost:${XTTS_PORT:-18770}/health"
wait_for "Orchestrator" "http://localhost:${ORCHESTRATOR_PORT:-4000}/health"

log_json "starting voice server" "satellite"
exec "$PY" server.py
