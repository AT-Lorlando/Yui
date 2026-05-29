# Yui — Assistante personnelle domotique

Yui est une assistante vocale locale qui contrôle l'appartement via commande vocale ou application mobile. Elle tourne entièrement en local, sans cloud, sur un serveur Linux.

## Fonctionnalités

- **Commande vocale** — wakeword "Hey Yui" → STT → LLM → TTS → Chromecast
- **Domotique** — lumières Hue, serrure Nuki, TV Samsung, Chromecast, volets Somfy
- **Musique** — Spotify via WiiM Ultra (Spotify Connect)
- **Informations** — météo, calendrier, emails, notes Obsidian
- **Automatisations** — scènes, cron jobs, détection de présence GPS/MAC
- **App web/mobile** — interface de contrôle unifiée Nuxt (port 3000)

## Architecture

```
[Satellite micro] ──WS──► [Voice server Python]
                              │ wakeword + VAD + Whisper
                              ▼
                         [Orchestrateur :4000]
                              │ Deepseek LLM
                         ┌────┴────────────────────────┐
                         │        MCP Servers           │
                         │  Hue · Nuki · Spotify        │
                         │  Chromecast · Samsung TV     │
                         │  Calendar · Gmail · Weather  │
                         │  Timer · Obsidian · Linear   │
                         │  Somfy · Irrigation · Browser│
                         │  Search (Tavily)             │
                         └─────────────────────────────┘
                                  │ réponse TTS
                         [XTTS v2] ──► [Google Home Max "Salon"]

      [App Nuxt (mobile/) :3000] ── UI web + mobile (proxy → :4000)
```

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Orchestrateur | Node.js / TypeScript |
| Voice pipeline | Python (Porcupine, Silero, Whisper, XTTS) |
| Outils domotiques | MCP (Model Context Protocol) |
| App web/mobile | Nuxt (`mobile/`, sous-module) |
| LLM | Deepseek (API OpenAI-compatible) |
| Process manager | PM2 |

## Structure du projet

```
Yui/
├── orchestrator/
│   └── src/
│       ├── main.ts                # Entry point
│       ├── orchestrator/          # LLM loop, automations, scenes, presence
│       └── input/                 # HTTP API (port 4000), stdin
├── voice/                         # Serveur voix Python (wakeword, VAD, ASR, TTS)
├── packages/
│   ├── mcp-hue/                   # Philips Hue
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
│   ├── mcp-browser/               # Navigation web
│   └── shared/                    # GoogleAuth partagé
├── mobile/                        # App unifiée Nuxt (web + mobile, sous-module)
├── prompts/                       # System prompts LLM
├── data/                          # État persistant (scenes, automations, memory...)
├── assets/                        # Wakeword, chimes, ringtones, media
└── ecosystem.config.js            # Config PM2
```

## Installation

### Prérequis

- Node.js 20+
- Python 3.11+
- PM2 (`npm install -g pm2`)
- ffmpeg (pour le streaming media)

### Dépendances Python

```bash
pip install pvporcupine faster-whisper silero-vad xtts torch resemblyzer
```

### Setup

```bash
# Dépendances Node
npm install

# Build
npm run build

# Google OAuth (Calendar + Gmail)
npm run setup:google

# Hue (pairing)
npm run setup:hue

# Spotify
npm run setup:spotify
```

### Variables d'environnement

Copier `.env.example` → `.env` et renseigner :

```env
# LLM
OPENAI_BASE_URL=...
OPENAI_API_KEY=...
OPENAI_MODEL=deepseek-chat

# Auth
BEARER_TOKEN=...

# Porcupine (wakeword)
PORCUPINE_ACCESS_KEY=...    # console.picovoice.ai
PORCUPINE_MODEL_PATH=assets/wakeword/yui.ppn

# Google
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# Hue, Nuki, Obsidian, etc.
HUE_BRIDGE_IP=...
HUE_API_KEY=...
```

### Wakeword Porcupine

1. Créer un compte sur [console.picovoice.ai](https://console.picovoice.ai)
2. Récupérer l'AccessKey
3. Entraîner un keyword "Hey Yui" (French) → télécharger le `.ppn` Linux
4. Placer à `assets/wakeword/yui.ppn`

### Démarrage

```bash
npm run pm2:start    # démarre tous les processus
npm run pm2:status   # état
pm2 logs             # logs en temps réel
```

## Développement

```bash
npm run dev           # orchestrateur en mode watch (ts-node)
npm run dev:app       # app Nuxt en mode web (dev)
npm run dev:hue       # tester le MCP Hue seul
# etc. pour chaque package
```

## Dashboard

Accessible sur `http://localhost:3002` :
- État des processus PM2
- Testeur d'ordres LLM
- Playground MCP (appel direct de tools)

## Ajouter un appareil / intégration

1. Créer `packages/mcp-xxx/src/index.ts` (interface MCP standard)
2. L'enregistrer dans `src/orchestrator/serverConfigs.ts`
3. Optionnel : masquer certains tools du LLM via `LLM_HIDDEN_TOOLS`
4. `npm run build && pm2 reload yui-orchestrator`
