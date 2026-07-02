# @yui/mcp-chromecast

Contrôle de la TV du salon via le **Chromecast with Google TV** (`CHROMECAST_HOST`, défaut
`10.0.0.140`) : lancement d'apps de streaming, affichage du dashboard (Fully Kiosk), fonds
d'écran / vidéos, et préparation de la TV (allumage + HDMI3).

Chaque commande de cast **prépare d'abord la TV** : Wake-on-LAN + bascule sur HDMI3 (l'entrée
du Chromecast). Côté TS c'est le wrapper `withTvOn()` (→ `tv.ensureOn()` du `LocalTizenBackend`),
côté Python `tv_prep.prepare()`.

## Tools exposés

| Tool | Rôle |
| --- | --- |
| `cast_youtube` / `cast_netflix` / `cast_crunchyroll` / `cast_disney` / `cast_prime` | Lance l'app + deep-link optionnel (`title`) |
| `cast_app` | Lance une des apps ci-dessus (`app` = enum) |
| `cast_dashboard` | Allume la TV + HDMI3 **et lance Fully Kiosk** (affiche le dashboard) |
| `cast_stop` | Stoppe la lecture en cours |
| `find_show` / `remember_show` | Résolution / mémorisation plateforme d'une série |
| `cast_wallpaper` / `cast_video` | Média local (`assets/media/`) — cachés du LLM |
| `list_media` | Liste les médias — caché du LLM |

## Mécanismes de lancement

Trois voies distinctes selon l'app cible :

1. **Streaming (Netflix, Crunchyroll…)** — `cast.py` via **DIAL** (`POST /apps/<AppName>` sur
   `:8008`) avec repli **Cast SDK** (`CAST_APP_ID` dans `dial.py`). Ne marche que pour les apps
   qui s'enregistrent comme *receiver Cast*.

2. **Fully Kiosk (dashboard)** — `atv_launch.py` via le protocole **Android TV Remote v2**
   (ports 6466/6467). Fully **n'est pas un receiver Cast**, on ne peut donc pas la lancer par la
   voie 1 ; on la lance comme n'importe quelle app Android installée
   (`send_launch_app_command("de.ozerov.fully")` → `market://launch?id=…`). Gratuit, sans ADB.
   Package configurable via `FULLY_PACKAGE`.

3. **`FullyClient.ts` (Remote Admin, `:2323`)** — pilotage fin de Fully (screenOn / foreground /
   loadURL d'une URL arbitraire). ⚠️ **Nécessite Fully PLUS (payant)** → non utilisé par
   `cast_dashboard` (qui passe par la voie 2). Conservé pour un usage éventuel.

## Setup — Android TV Remote (pour `cast_dashboard` / Fully)

Une seule fois par machine :

```bash
npm run setup:atv        # depuis la racine du repo
```

Le script (`setup-atv.sh` → `atv_setup.py`) :

1. installe `androidtvremote2` (`pip --user`, repli `--break-system-packages` sur les distros PEP 668) ;
2. détecte la Google TV, affiche une invite → **un code à 6 caractères apparaît sur la TV**, tape-le
   dans le terminal ;
3. écrit le cert/clé appairés dans `data/state/atv-cert.pem` + `atv-key.pem` (résolus via
   `YUI_DATA_DIR`, sinon `<racine>/data`).

Idempotent : si un cert appairé fonctionne déjà, il ne fait rien. Le cert étant lié à l'appareil
(pas à l'hôte), il est copiable entre checkouts sans re-pairing.

## Dépendances Python

`cast.py` et `atv_launch.py` tournent sur le `python3` système (paquets en `~/.local`) :

- `pychromecast`, `websocket-client`, `requests` (cast / DIAL / JustWatch)
- `androidtvremote2` (lancement Fully — installé par `npm run setup:atv`)

## Variables d'environnement

| Var | Défaut | Rôle |
| --- | --- | --- |
| `CHROMECAST_HOST` | `10.0.0.140` | IP de la Google TV (cast **et** Android TV Remote) |
| `CHROMECAST_PORT` | `8009` | Port Cast SDK |
| `FULLY_PACKAGE` | `de.ozerov.fully` | Package de l'app Fully à lancer (voie 2) |
| `DASHBOARD_URL` | `http://<HOST>:3000/dashboard` | URL du dashboard (voie 3, Remote Admin) |
| `FULLY_IP` / `FULLY_PORT` / `FULLY_PASSWORD` | — / `2323` / — | Remote Admin Fully (voie 3, PLUS) |
| `MEDIA_DIR` | `assets/media` | Répertoire des médias locaux |
