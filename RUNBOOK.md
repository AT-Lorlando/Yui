# Yui — Runbook

How to set up and run Yui from scratch, or restart it after a reboot.

---

## TL;DR — Daily startup (already configured)

**Production (PM2 — one command, survives reboots):**
```bash
npm run pm2:start       # build + start all three processes
npm run pm2:status      # check everything is running
```

**Development (three terminals, hot-reload):**
```bash
# Terminal 1
npm run xtts-server

# Terminal 2
npm run dev

# Terminal 3
TTS_ENGINE=xtts npm run voice
```

The Raspberry Pi streams automatically — nothing to do there.

---

## Prerequisites

### Server requirements

| Requirement | Notes |
|---|---|
| Node.js 18+ | `node --version` |
| Python 3.12 (system) | For voice pipeline + record tool |
| Python 3.11 venv | For XTTS v2 — see [XTTS venv](#xtts-v2-venv) below |
| NVIDIA GPU + CUDA | For Whisper STT and XTTS TTS |
| `ffmpeg` | For audio test capture (`apt install ffmpeg`) |
| `ffplay` | For audio monitoring (`apt install ffmpeg`) |

### Python packages (system-wide)

```bash
pip3 install --break-system-packages \
  faster-whisper \
  scipy \
  pychromecast \
  zeroconf \
  edge-tts \
  kokoro \
  requests \
  numpy \
  soundfile
```

---

## First-time setup

### 1. Clone and install

```bash
git clone <repo-url> Yui
cd Yui
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Then fill in `.env` — see [Environment variables](#environment-variables) below.

### 3. Create the prompts directory

The `prompts/` directory ships with the repo and contains three starter files. Edit them to match your home before first run:

```
prompts/00-personality.md   # edit Yui's name, tone, language
prompts/01-home.md          # update device IPs, room names
prompts/02-rules.md         # adjust hard rules if needed
```

You can add any number of `.md` files here — they are picked up automatically with no restart.

### 4. Device setup (one-time per device)

Each device requires a one-time setup that writes credentials to `.env`. Skip any device you don't have.

---

#### Philips Hue

```bash
npm run setup:hue
```

- Auto-discovers the Hue bridge on the local network
- Prompts you to press the button on the bridge
- Writes `HUE_BRIDGE_IP` and `HUE_USERNAME` to `.env`

---

#### Nuki smart lock

```bash
# Find your bridge IP in the Nuki app: Manage Bridge > IP address
npm run setup:nuki -- 192.168.1.50
# or with a custom port:
npm run setup:nuki -- 192.168.1.50 8080
```

- Calls the Nuki bridge `/auth` endpoint (requires a button press on the bridge)
- Writes `NUKI_HOST`, `NUKI_PORT`, `NUKI_TOKEN` to `.env`

---

#### Spotify

**Step 1 — Create a Spotify app:**
1. Go to https://developer.spotify.com/dashboard
2. Create an app
3. Add a redirect URI: `http://<your-server-ip>:6145/callback`
4. Copy the Client ID and Client Secret into `.env`:

```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://<your-server-ip>:6145/callback
```

**Step 2 — OAuth flow:**
```bash
npm run setup:spotify
```
- Opens a browser for OAuth, writes `SPOTIFY_REFRESH_TOKEN` to `.env`

**Step 3 — Discover speakers:**
```bash
npm run setup:spotify:speakers
```
- Make sure all speakers are on and have been used with Spotify recently
- If a speaker shows "not linked to Spotify", open it in the Spotify app once, then re-run

Set the default speaker:
```
SPOTIFY_SEEDER_DEVICE=Chromecaste
```

---

#### Samsung TV (SmartThings + Wake-on-LAN)

No setup script — manual steps:

1. Create a SmartThings Personal Access Token at https://account.smartthings.com/tokens
2. Find the TV device ID:
   ```bash
   curl -H "Authorization: Bearer <your-token>" \
     https://api.smartthings.com/v1/devices | jq '.items[] | {id, name}'
   ```
3. Find the TV MAC address (shown in TV network settings or your router's ARP table)
4. Fill in `.env`:
   ```
   SMARTTHINGS_TOKEN=your-pat
   SMARTTHINGS_TV_DEVICE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   SMARTTHINGS_TV_MAC=D0:D0:03:30:48:4B
   SMARTTHINGS_TV_IP=10.0.0.133
   ```

> **WoL note:** Subnet broadcast (`x.x.x.255:9`) is required. Direct unicast and `255.255.255.255` both fail on this TV.

---

#### Linear

1. Go to Linear → Settings → API → Personal API keys
2. Create a key and add to `.env`:
   ```
   LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
   ```

---

#### Google Calendar

**Step 1 — Create OAuth credentials:**
1. Go to https://console.cloud.google.com/
2. Create or select a project
3. Enable the **Google Calendar API**: APIs & Services → Enable APIs → search "Google Calendar API"
4. Create OAuth 2.0 credentials: APIs & Services → Credentials → Create → **OAuth client ID → Desktop app**
5. If your app is in test mode, add your Google account as a test user: OAuth consent screen → Test users

**Step 2 — Run the setup:**
```bash
npm run setup:calendar
```
- Prompts for Client ID and Client Secret (or reads them from `.env`)
- Opens a browser for OAuth authorization
- Writes `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN` to `.env`

---

### 5. XTTS v2 venv

XTTS v2 (Coqui) requires Python 3.11 — the system Python is 3.12. A separate venv is required.

```bash
# Install Python 3.11 if not already available
sudo apt install python3.11 python3.11-venv

# Create the venv
python3.11 -m venv ~/.venvs/xtts

# Install TTS and dependencies
~/.venvs/xtts/bin/pip install \
  "TTS==0.22.0" \
  "transformers==4.46.0" \
  soundfile \
  librosa

# First run downloads ~2GB model — takes a few minutes
COQUI_TOS_AGREED=1 ~/.venvs/xtts/bin/python src/xtts_server.py
# Wait for "XTTS server ready on :18770" then Ctrl+C
```

The model is cached in `~/.local/share/tts/` after first download.

---

### 6. Raspberry Pi

The Pi should already be configured and streaming. To deploy from scratch or after a change:

```bash
# Copy files to the Pi
scp raspberry-pi/udp_stream.py rasp:~/udp_stream.py
scp raspberry-pi/audio_stream.service rasp:/tmp/

# Install and enable the service
ssh rasp 'sudo mv /tmp/audio_stream.service /etc/systemd/system/ && \
           sudo systemctl daemon-reload && \
           sudo systemctl enable audio_stream.service && \
           sudo systemctl start audio_stream.service'

# Verify
ssh rasp 'sudo systemctl status audio_stream.service'
```

See `raspberry-pi/README.md` for full details.

**Test the stream:**
```bash
# Stop voice_pipeline.py first — it also binds :5002
ffmpeg -f s16le -ar 48000 -ac 1 -i udp://0.0.0.0:5002 -t 5 /tmp/test.wav
```

---

## Environment variables

Full reference for `.env`:

```bash
# ── Core ──────────────────────────────────────────────────────────────
NODE_ENV=development          # or production
LOG_LEVEL=info                # error | warn | info | debug
BEARER_TOKEN=yui              # auth token for the HTTP /order endpoint
SAVE_STORIES=true             # set to true to enable story saving + indexing

# ── LLM ───────────────────────────────────────────────────────────────
OPENAI_API_KEY=sk-...         # Deepseek key (or OpenAI — field name kept for compat)
LLM_BASE_URL=https://api.deepseek.com   # omit for OpenAI
LLM_MODEL=deepseek-chat       # or gpt-4o, etc.

# ── Philips Hue ───────────────────────────────────────────────────────
HUE_BRIDGE_IP=10.0.0.x        # written by npm run setup:hue
HUE_USERNAME=xxxx             # written by npm run setup:hue

# ── Nuki ──────────────────────────────────────────────────────────────
NUKI_HOST=192.168.1.50        # written by npm run setup:nuki
NUKI_PORT=8080                # written by npm run setup:nuki
NUKI_TOKEN=xxxx               # written by npm run setup:nuki

# ── Spotify ───────────────────────────────────────────────────────────
SPOTIFY_CLIENT_ID=xxxx        # from developer.spotify.com
SPOTIFY_CLIENT_SECRET=xxxx    # from developer.spotify.com
SPOTIFY_REDIRECT_URI=http://<server-ip>:6145/callback
SPOTIFY_REFRESH_TOKEN=xxxx    # written by npm run setup:spotify
SPOTIFY_SEEDER_DEVICE=Chromecaste  # default playback speaker

# ── Samsung TV ────────────────────────────────────────────────────────
SMARTTHINGS_TOKEN=xxxx        # SmartThings Personal Access Token
SMARTTHINGS_TV_DEVICE_ID=xxxx-xxxx-...   # TV device ID in SmartThings
SMARTTHINGS_TV_MAC=D0:D0:03:30:48:4B    # TV MAC for Wake-on-LAN
SMARTTHINGS_TV_IP=10.0.0.133            # TV local IP

# ── Linear ────────────────────────────────────────────────────────────
LINEAR_API_KEY=lin_api_xxxx   # from Linear Settings > API

# ── Google Calendar ────────────────────────────────────────────────────
GOOGLE_CLIENT_ID=xxxx         # from Google Console OAuth credentials
GOOGLE_CLIENT_SECRET=xxxx     # from Google Console OAuth credentials
GOOGLE_CALENDAR_REFRESH_TOKEN=xxxx  # written by npm run setup:calendar

# ── Voice pipeline ────────────────────────────────────────────────────
SPEAK_PIPELINE_URL=http://localhost:3001/speak  # where scheduler posts TTS
```

---

## Running the orchestrator (text only, no voice)

```bash
npm run dev       # ts-node, auto-reloads on error
npm run debug     # same + LOG_LEVEL=debug
npm run start     # compiled JS (faster startup)
```

Send orders via stdin or HTTP:

```bash
# stdin
echo '{"order": "allume les lumières du salon"}' | npm run dev

# HTTP
curl -X POST http://localhost:3000/order \
  -H "Authorization: Bearer yui" \
  -H "Content-Type: application/json" \
  -d '{"order": "allume les lumières du salon"}'
```

---

## Running the full voice stack

Three terminals, in this order:

### Terminal 1 — XTTS TTS server

```bash
npm run xtts-server
# Wait for: "XTTS server ready on :18770"
# First startup: ~20s (model load) + downloads ~2GB on first ever run
```

### Terminal 2 — Orchestrator

```bash
npm run dev
# Wait for: "Connected to X MCP server(s). Total tools: Y"
```

### Terminal 3 — Voice pipeline

```bash
TTS_ENGINE=xtts npm run voice
# Wait for: "Listening for audio on UDP :5002"
# Yui will say something when ready
```

At this point, speak to the Raspberry Pi mic. Yui listens, transcribes, responds, and speaks the answer to the Salon speaker.

---

## Voice cloning (optional)

To make Yui speak with your voice instead of the built-in Lilya Stainthorpe voice:

```bash
# 1. Stop voice_pipeline.py (frees UDP :5002)

# 2. Speak naturally for ~12 seconds into the Pi mic
npm run record-voice
# Saves to assets/my_voice.wav

# 3. Use your voice
XTTS_SPEAKER_WAV=/home/chuya/Projet/Yui/assets/my_voice.wav \
TTS_ENGINE=xtts npm run voice
```

Tips for a good recording: varied sentences, no background noise, 10–20 seconds.

---

## Adding or editing prompt documents

The system prompt is read from `prompts/*.md` on every request — **no restart needed**.

```bash
# Edit an existing file
nano prompts/01-home.md

# Add a new context document (picked up automatically)
nano prompts/03-cooking.md
```

Files are concatenated in alphabetical order, then the orchestrator appends dynamic context (datetime, memory, story summaries).

---

## Memory management

Memory is stored in `data/memory.json`. Yui manages it automatically via voice commands:

```
"Yui, souviens-toi que j'aime le jazz le matin"
→ memory_save("musique", "préférence_matin", "jazz", "always")

"Yui, note ma recette de carbonara : 200g lardons, 3 œufs, parmesan, pas de crème"
→ memory_save("recettes", "carbonara", "...", "on-demand")

"Yui, qu'est-ce que tu sais sur moi ?"
→ memory_list()
```

You can also edit `data/memory.json` directly — changes take effect on the next request.

**Priority tiers:**
- `always` — injected into every prompt (use for small, frequent facts)
- `on-demand` — listed by name only, fetched when needed (use for recipes, notes, long lists)

---

## Scheduler (cron jobs)

Schedules are stored in `data/schedules.json` and managed via voice:

```
"Yui, rappelle-moi chaque lundi à 9h de faire le point Linear"
→ schedule_add("Point Linear", "0 9 * * 1", "Donne-moi un résumé de mes tickets Linear en cours.")

"Yui, éteins les lumières à minuit tous les soirs"
→ schedule_add("Lumières minuit", "0 0 * * *", "Éteins toutes les lumières.")

"Yui, quelles sont mes tâches planifiées ?"
→ schedule_list()
```

Schedules persist across restarts and run in `Europe/Paris` timezone. When a job fires, Yui runs the prompt and speaks the response via the Salon speaker (requires voice pipeline to be running).

---

## Production — PM2

PM2 manages all three processes as daemons: they survive terminal closes, auto-restart on crash, and can be configured to start on system boot.

### Processes

| PM2 name | What it runs | Port |
|---|---|---|
| `yui-xtts` | XTTS v2 TTS server (Python 3.11 venv) | 18770 |
| `yui-orchestrator` | MCP orchestrator (compiled JS) | 3000 |
| `yui-voice` | Voice pipeline — waits for the two above | 3001 (speak), 18765 (TTS audio) |

`yui-voice` is launched via `scripts/start-voice.sh`, which polls `GET /health` on both `yui-xtts` and `yui-orchestrator` before starting the pipeline — no race conditions on restart.

### First start (after build)

```bash
npm run pm2:start
# Equivalent to: npm run build && pm2 start ecosystem.config.js
```

### Daily commands

```bash
npm run pm2:status      # overview of all processes
npm run pm2:logs        # tail all logs (Ctrl+C to exit)
pm2 logs yui-voice      # logs for a specific process
pm2 logs yui-xtts --lines 50

npm run pm2:stop        # stop all processes
npm run pm2:restart     # restart all (no rebuild)
npm run pm2:reload      # rebuild + zero-downtime reload
```

### Auto-start on server boot

```bash
npm run pm2:startup     # prints a command — run it as instructed (usually with sudo)
npm run pm2:save        # save current process list so it survives reboot
```

After this, PM2 will restart all three processes automatically when the server boots.

### Deploy a code change

```bash
git pull
npm run pm2:reload      # rebuild + graceful reload
```

### Environment variables in PM2

PM2 apps inherit `.env` via the `dotenv` call inside the app. If you update `.env`, restart to pick up changes:

```bash
npm run pm2:restart
```

---

## Troubleshooting

### Voice pipeline hears nothing / transcription is empty

```bash
# Check the stream is arriving
ffmpeg -f s16le -ar 48000 -ac 1 -i udp://0.0.0.0:5002 -t 5 /tmp/test.wav
# If file is empty → Pi stream is not reaching the server

# Check Pi service
ssh rasp sudo systemctl status audio_stream.service
ssh rasp sudo systemctl restart audio_stream.service
```

### XTTS server crashes on startup

```bash
# Check venv Python version
~/.venvs/xtts/bin/python --version  # must be 3.11.x

# Re-install if needed
~/.venvs/xtts/bin/pip install "TTS==0.22.0" "transformers==4.46.0"
```

### Chromecast not found

The voice pipeline discovers cast devices via Bonjour on startup. If your cast device IP changed:

```bash
# Check what's on the network
python3 -c "import pychromecast; cc, _ = pychromecast.get_chromecasts(timeout=10); [print(c.name, c.cast_info.host) for c in cc]"
```

Update `prompts/01-home.md` with the new IP if it changed.

### MCP server fails to connect

```bash
# Test a server standalone
npm run dev:hue
npm run dev:spotify
npm run dev:samsung
# etc — each should print its available tools and wait
```

Check that the relevant `.env` credentials are set for that server.

### Story summaries not appearing

Make sure `SAVE_STORIES=true` is set in `.env`. Summaries are generated asynchronously after each conversation — they appear from the second interaction onward.
