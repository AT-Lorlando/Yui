#!/usr/bin/env bash
# Crée (ou met à jour) les deux venvs Python de la voix, à côté des scripts :
#   voice/.venv       — serveur voix (server.py), Python 3.12, requirements.txt
#   voice/.venv-xtts  — moteur XTTS (tts_engine.py), Python 3.11, requirements-xtts.txt
# Emplacements surchargeables : VOICE_VENV / XTTS_VENV (aussi lus par start.sh
# et start-tts.sh). Idempotent : relancer après un changement de requirements.
#
#   voice/setup-venv.sh            # les deux
#   voice/setup-venv.sh voice      # serveur voix seulement
#   voice/setup-venv.sh xtts       # XTTS seulement
set -euo pipefail
cd "$(dirname "$0")"

VOICE_VENV="${VOICE_VENV:-$PWD/.venv}"
XTTS_VENV="${XTTS_VENV:-$PWD/.venv-xtts}"
what="${1:-all}"

pick_python() {   # premier interpréteur disponible parmi les candidats
    for c in "$@"; do command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return; }; done
    echo "[setup-venv] aucun interpréteur parmi : $*" >&2
    exit 1
}

make_venv() {     # make_venv <dir> <python> <requirements>
    local dir="$1" py="$2" req="$3"
    if [[ ! -x "$dir/bin/python" ]]; then
        echo "[setup-venv] création de $dir avec $py"
        "$py" -m venv "$dir"
    fi
    "$dir/bin/python" -m pip install --upgrade pip wheel >/dev/null
    echo "[setup-venv] pip install -r $req → $dir"
    "$dir/bin/python" -m pip install -r "$req"
}

if [[ "$what" == "all" || "$what" == "voice" ]]; then
    make_venv "$VOICE_VENV" "$(pick_python python3.12 python3)" requirements.txt
    "$VOICE_VENV/bin/python" -c "import ctranslate2, openwakeword, pychromecast; print('[setup-venv] voix OK — GPU CUDA pour Whisper :', ctranslate2.get_cuda_device_count())"
fi
if [[ "$what" == "all" || "$what" == "xtts" ]]; then
    make_venv "$XTTS_VENV" "$(pick_python python3.11)" requirements-xtts.txt
    "$XTTS_VENV/bin/python" -c "import torch, TTS; print('[setup-venv] XTTS OK — CUDA :', torch.cuda.is_available())"
fi
