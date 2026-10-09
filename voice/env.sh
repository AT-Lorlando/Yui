#!/usr/bin/env bash
# Chargeur de .env pour les scripts voix — PAS de `source` : un `source` évalue
# chaque ligne comme du shell, et `XTTS_SPEAKER=Ana Florence` (valeur avec
# espace, sans guillemets) lançait la commande « Florence » → `set -e` tuait
# yui-voice au démarrage (prod, 09/10/2026). Ici chaque ligne KEY=VALUE est
# exportée telle quelle : espaces, JSON, `#` dans la valeur conservés ;
# guillemets englobants retirés ; lignes vides et commentaires ignorés.
load_env() {
    local file="$1" line key val
    [[ -f "$file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        [[ -z "${line// }" || "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
        key="${BASH_REMATCH[2]}"
        val="${BASH_REMATCH[3]}"
        val="${val%"${val##*[![:space:]]}"}"           # espaces de fin
        if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then
            val="${BASH_REMATCH[1]}"
        fi
        export "$key=$val"
    done < "$file"
}
