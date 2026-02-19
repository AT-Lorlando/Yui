# mcp-spotify

MCP server for Spotify playback control and speaker management via Bonjour (mDNS) discovery.

## Setup

### 1. Create a Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Create a new app
3. Set the redirect URI to `http://localhost:6145/callback`
4. Copy the **Client ID** and **Client Secret**

### 2. Add credentials to `.env`

```env
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://localhost:6145/callback
```

### 3. SSH tunnel (headless server)

If Yui runs on a remote server, the setup callback must reach it from your local browser. Since Spotify requires `localhost` or `127.0.0.1` as redirect host, open an SSH tunnel from your workstation **before** running setup:

```bash
ssh -L 6145:localhost:6145 yui
```

This forwards your local port 6145 to the server, so the Spotify callback reaches the setup server.

### 4. Auth setup

```bash
npm run setup:spotify
```

This will:
- Print an authorization URL — open it in your browser
- Wait for the OAuth callback on port 6145
- Exchange the code for access and refresh tokens
- Write `SPOTIFY_REFRESH_TOKEN` to `.env`

### 5. Speaker setup

Before running, make sure all speakers are powered on and have been used with Spotify at least once (open the Spotify app → Devices → select each speaker).

```bash
npm run setup:spotify:speakers
```

This will:
- List active Spotify Connect devices
- Discover speakers on the local network via Bonjour
- Match speakers to Spotify device IDs (persistent, saved to `.entities/mcp-spotify.json`)
- Print a summary of linked devices

You can re-run this command anytime to link new speakers.

## Run

```bash
# Standalone (for testing)
npm run dev:spotify

# As part of Yui (started automatically by orchestrator)
npm run dev
```

## Tools

| Tool | Description |
|---|---|
| `list_speakers` | List all discovered speakers |
| `play_music` | Play/resume music (optional: speaker, query, URI) |
| `pause_music` | Pause playback |
| `next_track` | Skip to next track |
| `previous_track` | Skip to previous track |
| `set_volume` | Set volume (0-100) |
| `get_playback_state` | Current track, device, progress |
| `search_music` | Search tracks/albums/playlists |
| `refresh_speakers` | Re-discover speakers via Bonjour |

## Speaker Discovery

Speakers are discovered using Bonjour/mDNS (`_googlecast._tcp`), which finds Google Cast-compatible devices (Chromecast, Google Home, Nest, etc.) on the local network. Discovered speakers are matched against Spotify Connect devices by name to enable playback transfer.
