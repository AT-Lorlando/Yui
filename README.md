# Yui — Assistante personnelle domotique

Yui est une assistante vocale locale qui contrôle l'appartement via commande vocale ou application mobile. Elle tourne entièrement en local, sans cloud, sur un serveur Linux.

## Fonctionnalités

- **Commande vocale** — wakeword "Hey Yui" → STT → LLM → TTS → Chromecast
- **Domotique** — lumières Hue (+ Govee LAN), serrure Nuki, TV Samsung, Chromecast, volets Somfy, irrigation
- **Musique** — Spotify via WiiM Ultra (Spotify Connect)
- **Informations** — météo, calendrier, emails, notes Obsidian, recherche web
- **Automatisations** — scènes, cron jobs, détection de présence GPS/MAC, télécommandes Hue, proactivité
- **App web/mobile** — interface de contrôle unifiée Nuxt (port 3000)

## Architecture

```
[Pi micro] ──UDP :5002──► [Voice server Python (voice/server.py)]
                              │ OpenWakeWord + webrtcvad + faster-whisper (STT)
                              │ (+ DebugHub WebSocket :5051 pour la page /debug)
                              ▼ POST /order
                         [Orchestrateur :4000]
                              │ LLM (API OpenAI-compatible — llama-server local)
                              │ Virtual tools (memory, automations, scenes)
                         ┌────┴────────────────────────┐
                         │        MCP Servers           │
                         │  Hue · Nuki · Spotify        │
                         │  Chromecast · Samsung TV     │
                         │  Calendar · Gmail · Weather  │
                         │  Timer · Obsidian · Linear   │
                         │  Somfy · Irrigation · Browser│
                         │  Search (Tavily, externe)    │
                         └─────────────────────────────┘
                                  │ réponse texte → TTS
                         [XTTS v2] ──► [Google Home Max "Salon"]

      [App Nuxt (mobile/, submodule) :3000] ── UI web + mobile (proxy → :4000)
```

Le **Raspberry Pi** n'est qu'un micro réseau : un service systemd streame l'audio brut en UDP vers le serveur (`satellite/udp_stream.py`). Toute la détection wakeword / VAD / STT est centralisée côté serveur (`voice/`).

## Stack technique

| Composant         | Technologie                                                   |
| ----------------- | ------------------------------------------------------------- |
| Orchestrateur     | Node.js / TypeScript                                          |
| Voice pipeline    | Python (OpenWakeWord, webrtcvad, faster-whisper, XTTS v2)     |
| Outils domotiques | MCP (Model Context Protocol)                                  |
| App web/mobile    | Nuxt + Capacitor (`mobile/`, **submodule git**)              |
| LLM               | API OpenAI-compatible (llama-server local ; Deepseek possible)|
| Process manager   | PM2                                                           |

## Structure du projet

```
Yui/
├── orchestrator/                  # Node/TS — entry point, LLM loop, API HTTP :4000 (hors npm workspaces)
│   └── src/
│       ├── main.ts                # Entry point
│       ├── orchestrator/          # LLM loop, automations, scenes, presence, proactive, hueRemotes
│       └── input/                 # HTTP API (port 4000), stdin
├── packages/                      # npm workspaces (buildés ensemble)
│   ├── shared/                    # @yui/shared — GoogleAuth, dataPaths (dépendance des mcp-*)
│   ├── mcp-hue/                   # Philips Hue (+ Govee LAN)
│   ├── mcp-nuki/                  # Serrure Nuki
│   ├── mcp-spotify/               # Spotify → WiiM
│   ├── mcp-chromecast/            # Chromecast + Samsung TV + routage séries
│   ├── mcp-samsung/               # TV Samsung (WebSocket)
│   ├── mcp-timer/                 # Timers
│   ├── mcp-calendar/              # Google Calendar
│   ├── mcp-gmail/                 # Gmail
│   ├── mcp-weather/               # Météo
│   ├── mcp-obsidian/              # Notes Obsidian
│   ├── mcp-linear/                # Tickets Linear
│   ├── mcp-somfy/                 # Volets Somfy (Tahoma)
│   ├── mcp-irrigation/            # Arrosage
│   └── mcp-browser/               # Navigation web
│   #  (mcp-search = Tavily, spawné via `npx tavily-mcp@latest`, pas un package local)
├── voice/                         # Serveur voix Python (wakeword, VAD, ASR, TTS) — PM2 yui-voice/yui-tts
├── satellite/                     # Raspberry Pi : udp_stream.py (actuel) + ancien satellite OWW (legacy)
├── mobile/                        # App unifiée Nuxt (web + mobile) — SUBMODULE git (repo YuiApp)
├── prompts/                       # System prompts LLM
├── data/                          # config/ (éditée) · state/ (runtime) · shared/ (credentials)
├── assets/                        # Wakeword (yui.onnx), chimes, ringtones, media
├── ecosystem.config.js            # PM2 — orchestrator, tts, voice
└── ecosystem.config.cjs           # PM2 — yui-app (Nuxt SSR)
```

> `mobile/` est un **submodule git** (`git@github.com:AT-Lorlando/YuiApp.git`) : ses commits sont
> poussés sur le repo `YuiApp`, le repo parent ne versionne qu'un pointeur de commit.

## Installation

### Prérequis

- Node.js 20+
- Python 3.11+
- PM2 (`npm install -g pm2`)
- ffmpeg (pour le streaming media et l'audio du Pi)

### Clone (avec le submodule)

```bash
git clone --recursive git@github.com:AT-Lorlando/Yui.git
# ou, après un clone classique :
git submodule update --init --recursive
```

### Dépendances Python (serveur voix)

```bash
pip install openwakeword==0.4.0 onnxruntime webrtcvad faster-whisper TTS torch numpy
```

### Setup

```bash
# Dépendances Node (installe aussi le submodule mobile/)
npm install

# Build (packages + orchestrateur + app web)
npm run build

# Google OAuth unifié (Calendar + Gmail)
npm run setup:google

# Hue (pairing)
npm run setup:hue

# Spotify
npm run setup:spotify
```

### Variables d'environnement

Copier `.env.example` → `.env` et renseigner (extrait) :

```env
# LLM (API OpenAI-compatible — llama-server local en prod)
LLM_BASE_URL=http://localhost:8080/v1
LLM_MODEL=...
OPENAI_API_KEY=...            # peut être factice pour llama-server

# Auth API orchestrateur
BEARER_TOKEN=...
ORCHESTRATOR_PORT=4000

# Wakeword (OpenWakeWord)
WAKEWORD_MODEL=assets/wakeword/yui.onnx
WAKEWORD_THRESHOLD=0.5

# Hue, Nuki, Spotify, SmartThings (TV), Google, Linear...
HUE_BRIDGE_IP=...
HUE_USERNAME=...
NUKI_HOST=...
NUKI_TOKEN=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

> Les env vars définies dans `ecosystem.config.js` **écrasent** `.env`. Mettre à jour les deux.

### Wakeword (OpenWakeWord)

Le modèle est entraîné sur la voix : `assets/wakeword/yui.onnx` (backbones melspec/embedding bundlés
dans le package `openwakeword==0.4.0`). Pour ré-entraîner :

```bash
python scripts/record_wakeword.py     # enregistrer des échantillons
python scripts/train_wakeword.py      # entraîner → assets/wakeword/yui.onnx
pm2 restart yui-voice                 # activer
```

Voir `assets/wakeword/README.md`. Aucune dépendance Picovoice/Porcupine.

### Démarrage

```bash
npm run pm2:start    # build + démarre orchestrator, tts, voice
pm2 start ecosystem.config.cjs   # démarre l'app web/mobile (yui-app)
npm run pm2:status   # état
pm2 logs             # logs en temps réel
```

> Sur le Pi : le service systemd `audio_stream.service` (`satellite/udp_stream.py`) streame l'audio.
> `sudo systemctl status/restart audio_stream`.

## Développement

```bash
npm run dev           # orchestrateur en mode watch (ts-node)
npm run dev:app       # app Nuxt en mode web (dev) — délègue à mobile/
npm run dev:hue       # tester le MCP Hue seul
# etc. pour chaque package
```

> ⚠️ Build *from scratch* : les workspaces sont buildés par ordre alphabétique, donc `@yui/shared`
> (dépendance des `mcp-*`) passe en dernier. Si `dist/` est effacé, faire d'abord
> `npm run build -w @yui/shared`.

## App web/mobile

Interface unifiée Nuxt servie sur `http://localhost:3000` (proxy vers l'orchestrateur :4000) :
contrôle des appareils, scènes, automatisations, télécommandes Hue, page debug voix (`/debug`).
Build mobile natif via Capacitor (`mobile/android/`) — voir `mobile/README.md` et `mobile/CLAUDE.md`.

## Ajouter un appareil / intégration

1. Créer `packages/mcp-xxx/src/index.ts` (interface MCP standard)
2. L'enregistrer dans `orchestrator/src/orchestrator/serverConfigs.ts`
3. Optionnel : masquer certains tools du LLM via `LLM_HIDDEN_TOOLS`
4. `npm run build && pm2 reload yui-orchestrator`
