#!/usr/bin/env bash
# Source voice/.env, attend XTTS + orchestrateur, puis lance le pipeline voix.
set -e
cd "$(dirname "$0")"            # voice/
set -a; source ./.env; set +a  # CUDA_VISIBLE_DEVICES posé avant torch

wait_for() {
    local name="$1"
    local url="$2"
    echo "[voice] Waiting for $name ($url)..."
    until curl -sf "$url" >/dev/null 2>&1; do
        sleep 3
    done
    echo "[voice] $name is ready."
}

wait_for "XTTS server"  "http://localhost:${XTTS_PORT:-18770}/health"
wait_for "Orchestrator" "http://localhost:${ORCHESTRATOR_PORT:-4000}/health"

echo "[voice] Starting voice server (satellite mode)..."
exec python3 server.py
