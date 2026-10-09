#!/usr/bin/env bash
# Résolution de l'interpréteur Python des scripts voix : le venv dédié s'il
# existe (voice/.venv ou voice/.venv-xtts, surchargeables par VOICE_VENV /
# XTTS_VENV dans voice/.env), sinon repli sur un interpréteur global AVEC
# avertissement — c'est ce repli (python3 système sans pychromecast) qui
# faisait planter yui-voice en prod le 09/10/2026.
#   voice_python <VENV_DIR> <repli>   → écrit le chemin de l'interpréteur
voice_python() {
    local venv="$1" fallback="$2"
    if [[ -x "$venv/bin/python" ]]; then
        echo "$venv/bin/python"
    else
        echo "[voice] venv absent ($venv) — repli sur $fallback ; lancer voice/setup-venv.sh" >&2
        command -v "$fallback" || { echo "[voice] $fallback introuvable" >&2; return 1; }
    fi
}
