#!/usr/bin/env bash
# Waits for XTTS server and orchestrator to be healthy, then starts the voice pipeline.
# Used by PM2 ecosystem so the voice pipeline only starts once its dependencies are up.
set -e

cd "$(dirname "$0")/.."

wait_for() {
    local name="$1"
    local url="$2"
    echo "[voice] Waiting for $name ($url)..."
    until curl -sf "$url" >/dev/null 2>&1; do
        sleep 3
    done
    echo "[voice] $name is ready."
}

wait_for "XTTS server"    "http://localhost:18770/health"
wait_for "Orchestrator"   "http://localhost:3000/health"

echo "[voice] Starting voice pipeline..."
exec python3 src/voice_pipeline.py
