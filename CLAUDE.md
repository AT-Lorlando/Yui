# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Running Yui for the first time?** See **[RUNBOOK.md](./RUNBOOK.md)** — full setup guide, device configuration, and daily operation.

## Commands

```bash
# Setup (first-time device configuration)
npm run setup:hue                        # Discover Hue bridge, create user, write .env
npm run setup:nuki -- 192.168.1.50       # Create Nuki token (requires bridge IP)
npm run setup:nuki -- 192.168.1.50 8080  # With explicit port
npm run setup:spotify                    # Spotify OAuth (writes refresh token to .env)
npm run setup:spotify:speakers           # Discover speakers + link Spotify device IDs
npm run setup:calendar                   # Google Calendar OAuth (writes refresh token to .env)

# Development
npm run dev           # Run orchestrator with ts-node (spawns MCP servers automatically)
npm run debug         # Run with LOG_LEVEL=debug
npm run start         # Run compiled orchestrator with LOG_LEVEL=info

# Individual MCP servers (for testing)
npm run dev:hue       # Run mcp-hue server standalone
npm run dev:nuki      # Run mcp-nuki server standalone
npm run dev:browser   # Run mcp-browser server standalone
npm run dev:spotify   # Run mcp-spotify server standalone
npm run dev:linear    # Run mcp-linear server standalone
npm run dev:samsung   # Run mcp-samsung server standalone
npm run dev:calendar  # Run mcp-calendar server standalone
npm run dev:weather   # Run mcp-weather server standalone

# Voice pipeline (run all three together for full voice loop)
npm run xtts-server   # Start XTTS v2 TTS server (Python 3.11 venv, port 18770)
npm run voice         # Start voice pipeline (UDP mic → Whisper → /order → TTS → Chromecast)
npm run record-voice  # Record voice reference for XTTS cloning (assets/my_voice.wav)

# Build
npm run build         # Build all packages + orchestrator
npm run build:packages  # Build workspace packages only

# Testing
npm test              # Run all tests (Jest)
npm run test:e2e      # End-to-end tests only
npm run test:unit-int # Unit and integration tests only

# Linting & Formatting
npm run lint          # ESLint with auto-fix
npm run lint:check    # ESLint without fix
npm run format        # Prettier format
npm run format:check  # Prettier check without changes
```

## Architecture

Yui is a natural language smart home orchestration system using a **monorepo + MCP (Model Context Protocol)** architecture.

User text commands are processed by the orchestrator, which uses OpenAI's native `tool_use` to call MCP servers representing physical devices. A single LLM decides directly which tools to call — no router LLM, no `eval()`, no specialist agents.

### Full System Flow (Voice)

```
Raspberry Pi mic
    ↓ FFmpeg → raw PCM s16le 48kHz → UDP :5002
Yui server — voice_pipeline.py
    ↓ Energy VAD (detect speech)
    ↓ faster-whisper (CUDA, RTX 3090) → transcription
    ↓ POST /order  (HTTP :3000, Bearer token)
Orchestrator (src/orchestrator.ts)
    ↓ Build system prompt (prompts/*.md + memory + story summaries)
    ↓ LLM tool_use loop (Deepseek)
    ↓ Virtual tools (memory, schedule, story) + MCP tool calls
MCP Servers (packages/mcp-*/), spawned as child processes (stdio)
    ↓ Hardware / external APIs (Hue, Nuki, Spotify, Samsung TV, Linear)
Orchestrator → text response
    ↓ voice_pipeline.py → POST /tts → xtts_server.py
    ↓ XTTS v2 (Coqui, Python 3.11 venv, CUDA) → WAV audio
    ↓ Served via HTTP :18765 → pychromecast → Salon (Google Home Max, 10.0.0.192)
```

### Text / HTTP Flow

```
stdin / HTTP POST /order
    ↓
Orchestrator (src/orchestrator.ts)
    ↓ Collects tools from all MCP servers via listTools()
    ↓ Sends user order to LLM with tools array
    ↓ LLM tool_use loop:
         - virtual tool call → handled in-process (memory, schedule, story)
         - MCP tool call → routes to MCP client → callTool()
         - tool_result → fed back to LLM
         - text response → exit loop
    ↓
MCP Servers (packages/mcp-*/), spawned as child processes (stdio)
    ↓
Hardware / external APIs
```

### Cron / Scheduled Tasks Flow

```
node-cron fires (Europe/Paris timezone)
    ↓ scheduler.ts → orchestrator.processOrder(prompt)
    ↓ HTTP POST :3001/speak → voice_pipeline.py _SpeakHandler
    ↓ speak() → TTS → Chromecast
```

### Monorepo Structure

```
Yui/
├── package.json              # workspace root
├── tsconfig.base.json        # shared TypeScript config
├── tsconfig.json             # orchestrator (src/) config
├── prompts/                  # hot-reload system prompt documents (markdown)
│   ├── 00-personality.md     # Yui's character, tone, voice style
│   ├── 01-home.md            # home layout, devices, cast map
│   └── 02-rules.md           # hard rules (Chromecast workflow, memory rules)
├── data/                     # runtime data (gitignored)
│   ├── memory.json           # persistent namespaced memory
│   ├── schedules.json        # cron job definitions
│   └── story-index.json      # summarized story index for retrieval
├── stories/                  # full conversation transcripts (gitignored)
├── raspberry-pi/             # Raspberry Pi deployment files
│   ├── udp_stream.py         # FFmpeg launcher + crash watchdog
│   ├── audio_stream.service  # systemd unit file
│   └── README.md             # deployment instructions
├── assets/
│   └── my_voice.wav          # XTTS voice clone reference (gitignored)
└── src/                      # Orchestrator + voice pipeline
    ├── main.ts               # entry point + scheduler init
    ├── orchestrator.ts       # tool_use loop + MCP client management + virtual tools
    ├── systemPrompt.ts       # dynamic prompt builder (reads prompts/*.md)
    ├── memory.ts             # namespaced persistent memory
    ├── storyArchive.ts       # story summarization + keyword retrieval
    ├── scheduler.ts          # node-cron dispatcher
    ├── story.ts              # conversation history persistence
    ├── listener.ts           # stdin / HTTP listener
    ├── env.ts                # environment variables
    ├── logger.ts             # Winston logger
    ├── voice_pipeline.py     # mic UDP → VAD → Whisper → /order → TTS → Chromecast
    ├── xtts_server.py        # XTTS v2 HTTP server (Python 3.11 venv)
    └── record_voice.py       # record voice reference for XTTS cloning
└── packages/
    ├── shared/               # shared types and logger
    ├── mcp-hue/              # MCP server: Philips Hue lights
    ├── mcp-nuki/             # MCP server: Nuki smart locks
    ├── mcp-spotify/          # MCP server: Spotify + speakers
    ├── mcp-linear/           # MCP server: Linear project management
    ├── mcp-samsung/          # MCP server: Samsung TV via SmartThings + WoL
    ├── mcp-calendar/         # MCP server: Google Calendar
    ├── mcp-weather/          # MCP server: Weather forecasts (Open-Meteo, no API key)
    └── mcp-browser/          # MCP server: Playwright browser (Phase 2)
```

### Key Layers

| Layer | Path | Role |
|---|---|---|
| Orchestrator | `src/orchestrator.ts` | LLM tool_use loop, MCP + virtual tool dispatch |
| System Prompt | `src/systemPrompt.ts` | Reads `prompts/*.md` + injects memory/stories/datetime |
| Memory | `src/memory.ts` | Namespaced persistent memory, two-tier injection |
| Story Archive | `src/storyArchive.ts` | Auto-summarize stories, keyword retrieval |
| Scheduler | `src/scheduler.ts` | node-cron jobs persisted in `data/schedules.json` |
| MCP Hue | `packages/mcp-hue/` | Hue lights (list, on/off, brightness, color) |
| MCP Nuki | `packages/mcp-nuki/` | Nuki doors (list, lock, unlock, state) |
| MCP Spotify | `packages/mcp-spotify/` | Spotify Connect playback + speaker control |
| MCP Linear | `packages/mcp-linear/` | Linear project management (Koya team) |
| MCP Samsung | `packages/mcp-samsung/` | Samsung TV via SmartThings API + Wake-on-LAN |
| MCP Calendar | `packages/mcp-calendar/` | Google Calendar (OAuth2, 11 tools) |
| MCP Weather | `packages/mcp-weather/` | Weather forecasts via Open-Meteo (no API key, 4 tools) |
| MCP Browser | `packages/mcp-browser/` | Playwright browser automation (Phase 2) |
| Shared | `packages/shared/` | Types and logger |
| Voice Pipeline | `src/voice_pipeline.py` | Mic → STT → orchestrator → TTS → Chromecast |
| XTTS Server | `src/xtts_server.py` | XTTS v2 TTS HTTP server (Python 3.11 venv) |

### MCP Tools

**mcp-hue**: `list_lights`, `turn_on_light`, `turn_off_light`, `set_brightness`, `set_color`, `refresh_lights`

**mcp-nuki**: `list_doors`, `lock_door`, `unlock_door`, `get_door_state`, `refresh_doors`

**mcp-spotify**: `list_speakers`, `play_music`, `pause_music`, `next_track`, `previous_track`, `set_volume`, `get_playback_state`, `search_music`, `refresh_speakers`, `play_album`, `play_playlist`, `play_artist_radio`, `set_shuffle`, `set_repeat`, `add_to_queue`, `get_my_playlists`

**mcp-linear**: `list_issues`, `get_issue`, `create_issue`, `update_issue`, `add_comment`, `list_projects`, `create_project`, `search_issues`

**mcp-samsung**: `tv_get_status`, `tv_power`, `tv_set_volume`, `tv_mute`, `tv_set_input`, `tv_prepare_chromecast`, `tv_launch_app`

**mcp-calendar**: `list_calendars`, `get_today`, `get_week`, `get_schedule`, `get_event`, `create_event`, `update_event`, `delete_event`, `search_events`, `find_free_slots`, `quick_add_event`

**mcp-browser**: `open_browser`, `get_page_content`, `click_element`, `fill_input`, `close_browser`

### Virtual Tools (in-process, no MCP)

These tools are handled directly inside the orchestrator — no MCP server required.

**Memory:**
- `memory_save(namespace, key, value, priority?)` — persist a fact
- `memory_delete(namespace, key)` — forget a fact
- `memory_read(namespace)` — read an on-demand namespace
- `memory_list()` — list all namespaces and sizes

**Story Archive:**
- `get_story_detail(id)` — fetch the full transcript of a past conversation

**Scheduler:**
- `schedule_add(name, cron, prompt)` — create a cron job
- `schedule_list()` — list all schedules
- `schedule_delete(id)` — remove a schedule
- `schedule_toggle(id)` — enable/disable without deleting

### Samsung TV — Chromecast Workflow

The orchestrator system prompt (`prompts/02-rules.md`) encodes this automatic workflow whenever music is requested:

1. `tv_prepare_chromecast` → Wake-on-LAN to `10.0.0.133` (subnet broadcast `10.0.0.255:9`), poll SmartThings until TV responds, switch input to HDMI3
2. `play_music` on speaker `"Chromecaste"` → Spotify Connect transfers playback to Chromecast

WoL via subnet broadcast (`10.0.0.255:9`) is required — direct unicast and `255.255.255.255` both fail on this TV.

### Story / Conversation History

Two layers:

**Short-term (in-memory):** Rolling buffer of the last 5 exchanges (10 messages) in `Orchestrator.conversationHistory`. Gives Yui context within a session. Resets on restart.

**Long-term (persistent):** After each conversation, `Story.save()` writes the full transcript to `stories/story-{id}.json` and fires `summarizeAndIndex()` asynchronously. A one-sentence LLM summary is stored in `data/story-index.json`. On every new request, keyword matching retrieves the top 3 relevant summaries and injects them into the system prompt with a `get_story_detail(id)` tool the LLM can call to read the full transcript.

---

## System Prompt — Hot-reload Markdown

The system prompt is assembled from Markdown files in `prompts/`. Files are **read on every request** — edits take effect immediately with no restart.

```
prompts/
├── 00-personality.md   # character, tone, voice style rules
├── 01-home.md          # home layout, devices, cast device map
├── 02-rules.md         # hard rules (Chromecast workflow, memory/schedule rules)
└── my-new-doc.md       # add any .md file → picked up automatically
```

Files are concatenated in alphabetical order, then the orchestrator appends:
- Current datetime (day, date, time — French locale)
- Memory (always-tier namespaces injected in full; on-demand namespaces listed)
- Relevant story summaries (keyword-matched from `data/story-index.json`)

**To add context at runtime:** just create a new `.md` file in `prompts/`. No restart needed.

---

## Persistent Memory

Stored in `data/memory.json`. Organized into **namespaces** with two injection tiers.

### Two-tier injection

| Tier | Behavior | Suitable for |
|---|---|---|
| `always` | Full content injected into every system prompt | Small, frequently relevant facts (name, preferences) |
| `on-demand` | Only namespace name listed; LLM fetches via `memory_read` | Large or rarely needed data (recipes, notes) |

### Example `data/memory.json`

```json
{
  "personnel": {
    "_priority": "always",
    "prénom": "Jérémy",
    "heure_réveil": "7h30",
    "langue": "Français"
  },
  "musique": {
    "_priority": "always",
    "style_préféré": "Jazz fusion, électro lounge",
    "playlist_matin": "Morning Vibes"
  },
  "recettes": {
    "_priority": "on-demand",
    "carbonara": "200g lardons, 3 œufs, parmesan, pas de crème !",
    "smoothie": "banane, épinards, lait d'amande"
  }
}
```

### What the LLM sees in the prompt

```
## Mémoire

### Données permanentes
[personnel]
  prénom: Jérémy
  heure_réveil: 7h30

[musique]
  style_préféré: Jazz fusion, électro lounge

### Données disponibles sur demande
Appelle memory_read(namespace) pour accéder à :
- recettes (2 entrées)
```

---

## Story Archive

Stored in `data/story-index.json` (summaries) and `stories/story-*.json` (full transcripts).

**On save:** `summarizeAndIndex()` calls the LLM with a short prompt to generate a 1-sentence summary (async, non-blocking — does not delay the response).

**On each new order:** `buildStorySummariesContext(order)` scores all indexed summaries via word overlap, takes the top 3, and injects them:

```
## Discussions passées pertinentes
- [2026-02-18] Jérémy a configuré la playlist Morning Vibes pour le lundi matin (id: 1708300000)
- [2026-02-17] Réglage des lumières du salon à 30% pour les soirées film (id: 1708290000)

Appelle get_story_detail(id) pour lire le transcript complet.
```

---

## Cron Scheduler

Schedules persisted in `data/schedules.json`. Loaded on startup. Timezone: `Europe/Paris`.

### Example `data/schedules.json`

```json
[
  {
    "id": "a1b2c3d4",
    "name": "Briefing matinal",
    "cron": "30 8 * * 1-5",
    "prompt": "Donne un briefing du matin : heure, jour, et mes tickets Linear en cours.",
    "enabled": true
  }
]
```

When a job fires: `processOrder(prompt)` → response text → `POST :3001/speak` → `voice_pipeline.py` speaks it.

### LLM examples

- *"Rappelle-moi chaque lundi à 9h de faire le point Linear"* → `schedule_add("Point Linear", "0 9 * * 1", "Donne-moi un résumé de mes tickets Linear en cours.")`
- *"Éteins toutes les lumières à minuit"* → `schedule_add("Lumières minuit", "0 0 * * *", "Éteins toutes les lumières.")`

---

## Environment

Copy `.env.example` to `.env`. Required variables:

- `OPENAI_API_KEY` — LLM API key (currently Deepseek: `sk-...`)
- `LLM_BASE_URL` — LLM endpoint (e.g. `https://api.deepseek.com`)
- `LLM_MODEL` — model name (e.g. `deepseek-chat`)
- `BEARER_TOKEN` — token for HTTP endpoint auth
- `HUE_BRIDGE_IP` / `HUE_USERNAME` — Philips Hue (written by `npm run setup:hue`)
- `NUKI_HOST`, `NUKI_PORT`, `NUKI_TOKEN` — Nuki (written by `npm run setup:nuki`)
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` — Spotify
- `SPOTIFY_SEEDER_DEVICE` — default Spotify Connect speaker name (e.g. `Chromecaste`)
- `LINEAR_API_KEY` — Linear personal API key (from Linear Settings → API)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth2 app credentials
- `GOOGLE_CALENDAR_REFRESH_TOKEN` — written by `npm run setup:calendar`
- `SMARTTHINGS_TOKEN` — SmartThings Personal Access Token
- `SMARTTHINGS_TV_DEVICE_ID` — Samsung TV device ID in SmartThings
- `SMARTTHINGS_TV_MAC` — TV MAC address for Wake-on-LAN (format `D0:D0:03:30:48:4B`)
- `SMARTTHINGS_TV_IP` — TV local IP for WoL subnet broadcast (e.g. `10.0.0.133`)
- `NODE_ENV`, `LOG_LEVEL`
- `SAVE_STORIES` — set to `true` to enable story saving + indexing
- `SPEAK_PIPELINE_URL` — URL of voice pipeline speak endpoint (default: `http://localhost:3001/speak`)

---

## Raspberry Pi — Audio Streaming Node

The Raspberry Pi (`raspberrypi`, `10.0.0.125`, `ssh rasp`) acts as a **remote microphone node**: it captures audio from a USB mic and streams it continuously over UDP to the Yui server. All AI processing happens on the Yui server — the Pi is a dumb audio relay.

**Source files are in `raspberry-pi/`.** See `raspberry-pi/README.md` for deployment instructions.

### Hardware

| Component | Details |
|---|---|
| Board | Raspberry Pi (aarch64, Debian 12 Bookworm) |
| Mic | USB Microphone — ALSA card 1, `hw:1,0` |
| Access | `ssh rasp` from the Yui server |

### Boot Behaviour — Does It Start Automatically?

**Yes.** The stream starts automatically on every boot, no login required.

- **`audio_stream.service`** is a **system-level systemd service** (`WantedBy=multi-user.target`)
- Status: `enabled` → runs on every boot
- Starts after `network.target`
- `Restart=always` → auto-restarts if FFmpeg crashes
- FFmpeg reads ALSA `hw:1,0` **directly** (bypasses PipeWire) → works with no user logged in

```
Power on → network up → audio_stream.service → udp_stream.py → FFmpeg → streaming
```

### Streaming Details

| Property | Value |
|---|---|
| Format | Raw PCM `s16le` (no WAV header) |
| Sample rate | 48 000 Hz, mono |
| Transport | UDP — connectionless, Pi keeps streaming even if server is down |
| Destination | `10.0.0.101:5002` |

### Test the Stream from Yui Server

```bash
# Stop voice_pipeline.py first (it also binds :5002)
ffmpeg -f s16le -ar 48000 -ac 1 -i udp://0.0.0.0:5002 -t 5 /tmp/test.wav
ffplay  -f s16le -ar 48000 -ac 1     udp://0.0.0.0:5002
```

---

## Voice Pipeline

Full voice interaction loop. Four processes work together:

```
[1] audio_stream.service  (on Pi, always running)
[2] xtts_server.py        (on Yui server)
[3] npm run dev           (orchestrator)
[4] voice_pipeline.py     (on Yui server)
```

### Starting the Voice Stack

```bash
# Terminal 1 — XTTS TTS server (loads ~2GB model, takes ~20s)
npm run xtts-server

# Terminal 2 — Orchestrator
npm run dev

# Terminal 3 — Voice pipeline (connects everything)
TTS_ENGINE=xtts npm run voice
```

### voice_pipeline.py (`src/voice_pipeline.py`)

```
UDP :5002 (s16le 48kHz)
  → Energy VAD (RMS threshold)
  → Speech segment accumulated
  → Resampled 48kHz → 16kHz
  → faster-whisper (CUDA, RTX 3090) → French transcription
  → POST http://localhost:3000/order  (Bearer token)
  → Response text → speak()
  → POST http://localhost:18770/tts  (xtts_server)
  → WAV audio served on :18765
  → pychromecast → Salon (Google Home Max, 10.0.0.192:8009)
```

Also exposes **`POST :3001/speak`** — accepts `{"text": "..."}` and calls `speak()` in a background thread. Used by the cron scheduler to trigger speech.

**Key environment variables:**

| Variable | Default | Description |
|---|---|---|
| `VOICE_UDP_PORT` | `5002` | UDP port to receive mic stream |
| `WHISPER_MODEL` | `small` | Whisper model size (`tiny`/`small`/`medium`/`large`) |
| `WHISPER_LANG` | `fr` | Transcription language |
| `TTS_ENGINE` | `kokoro` | TTS engine: `xtts` / `kokoro` / `openai` / `edge` |
| `TTS_SPEAKER` | `Salon` | Cast target device name (Bonjour discovery) |
| `LOCAL_IP` | `10.0.0.101` | This server's LAN IP (for Chromecast to fetch audio) |
| `BEARER_TOKEN` | `yui` | Auth token for `/order` endpoint |
| `SPEAK_PORT` | `3001` | Port for the `/speak` HTTP endpoint |

**VAD parameters** (edit `src/voice_pipeline.py`):

| Parameter | Value | Effect |
|---|---|---|
| `SPEECH_THRESHOLD` | 300 | RMS above this = start of speech |
| `SILENCE_THRESHOLD` | 200 | RMS below this = silence |
| `SPEECH_HOLD_FRAMES` | 8 | ~160ms of speech required before recording starts |
| `SILENCE_END_FRAMES` | 40 | ~800ms of silence ends the utterance |
| `MIN_UTTERANCE_S` | 0.5 | Ignore very short blips |
| `MAX_UTTERANCE_S` | 12.0 | Force transcription after this duration |

**Python dependencies** (installed system-wide with `--break-system-packages`):
- `faster-whisper` — CTranslate2 Whisper, CUDA
- `scipy` — polyphase resampling
- `pychromecast` + `zeroconf` — Chromecast discovery and casting
- `edge-tts` — Microsoft Neural TTS (fallback engine)
- `kokoro` — Kokoro-82M neural TTS (default engine)
- `requests`, `numpy`, `soundfile`

### xtts_server.py (`src/xtts_server.py`)

Local HTTP server wrapping **XTTS v2** (Coqui TTS). Runs in a dedicated Python 3.11 venv (`~/.venvs/xtts`) because Coqui TTS requires Python < 3.12.

**API:**
```
POST http://localhost:18770/tts
{
  "text":        "Bonjour !",
  "language":    "fr",
  "speaker":     "Lilya Stainthorpe",   # built-in (omit if using speaker_wav)
  "speaker_wav": "/path/to/ref.wav",    # voice clone reference (overrides speaker)
  "speed":       1.15                   # playback speed multiplier
}
→ audio/wav

GET /speakers   → JSON list of 58 built-in speaker names
GET /health     → 200 OK
```

**Chosen voice:** `Lilya Stainthorpe` at `speed=1.15`

**Known compatibility patches in `xtts_server.py`:**
- `torch.load` patched to force `weights_only=False` (PyTorch 2.6 breaking change)
- `torchaudio.load` patched to use `soundfile` directly (torchaudio removed `set_audio_backend`)

**Venv location:** `/home/chuya/.venvs/xtts` (Python 3.11, `TTS==0.22.0`, `transformers==4.46.0`)

### TTS Engines Compared

| Engine | Quality | Key needed | Notes |
|---|---|---|---|
| `xtts` | ★★★★★ | None | XTTS v2, best French quality, ~2s latency, supports voice cloning |
| `kokoro` | ★★★★☆ | None | Kokoro-82M, very fast (~0.5s), voice `ff_siwis` for French |
| `openai` | ★★★★★ | `OPENAI_TTS_KEY` | OpenAI `tts-1-hd`, cloud, needs real OpenAI key |
| `edge` | ★★★☆☆ | None | Microsoft Neural, robotic, no latency |

### Voice Cloning

```bash
# 1. Stop voice_pipeline.py (it uses UDP :5002)
# 2. Speak naturally for 12 seconds into the Pi mic:
npm run record-voice       # saves to assets/my_voice.wav

# 3. Use your voice:
XTTS_SPEAKER_WAV=/home/chuya/Projet/Yui/assets/my_voice.wav \
TTS_ENGINE=xtts npm run voice
```

### Cast Devices (Bonjour-discovered)

| Name | IP | Type |
|---|---|---|
| `Salon` | `10.0.0.192:8009` | Google Home Max ← **TTS output** |
| `Chromecaste` | `10.0.0.140:8009` | Chromecast ← Spotify music |
| `Google Home` | `10.0.0.189:8009` | Google Home |
| `Nest Hub` | `10.0.0.190:8009` | Google Nest Hub |
| `Les enceintes` | `10.0.0.190:32179` | Google Cast Group |
