# Raspberry Pi — Audio Streaming Node

The Raspberry Pi acts as a **dumb remote microphone**: it captures audio from a USB mic and streams raw PCM over UDP to the Yui server. All AI processing happens on the Yui server.

## Hardware

| Component | Details |
|---|---|
| Board | Raspberry Pi (aarch64, Debian 12 Bookworm) |
| Mic | USB Microphone — ALSA `hw:1,0` (card 1) |
| Access | `ssh rasp` from the Yui server |
| Yui server | `10.0.0.101` (LAN IP) |

## Files in this directory

| File | Deployed to |
|---|---|
| `udp_stream.py` | `/home/chuya/udp_stream.py` on the Pi |
| `audio_stream.service` | `/etc/systemd/system/audio_stream.service` on the Pi |

## Fresh deployment

```bash
# 1. Copy files to the Pi
scp raspberry-pi/udp_stream.py rasp:~/udp_stream.py
scp raspberry-pi/audio_stream.service rasp:/tmp/audio_stream.service

# 2. Install the systemd service
ssh rasp 'sudo mv /tmp/audio_stream.service /etc/systemd/system/ && \
           sudo systemctl daemon-reload && \
           sudo systemctl enable audio_stream.service && \
           sudo systemctl start audio_stream.service'

# 3. Verify
ssh rasp 'sudo systemctl status audio_stream.service'
```

## Service management

```bash
ssh rasp sudo systemctl status audio_stream.service   # status
ssh rasp sudo systemctl restart audio_stream.service  # restart
ssh rasp sudo systemctl stop audio_stream.service     # stop
ssh rasp sudo systemctl disable audio_stream.service  # disable at boot
```

## Audio stream details

| Property | Value |
|---|---|
| Format | Raw PCM `s16le` (no WAV header) |
| Sample rate | 48 000 Hz, mono |
| Transport | UDP (connectionless) |
| Destination | `udp://10.0.0.101:5002` |
| Mic device | ALSA `hw:1,0` (USB Microphone) |

FFmpeg reads ALSA directly (bypasses PipeWire) → works with no user logged in.

## Updating the destination IP

Edit `udp_stream.py` and change the IP in `FFMPEG_CMD`, then redeploy:

```bash
scp raspberry-pi/udp_stream.py rasp:~/udp_stream.py
ssh rasp sudo systemctl restart audio_stream.service
```

## Test the stream from the Yui server

```bash
# Capture 5 seconds to WAV (stop voice_pipeline.py first — it also binds :5002)
ffmpeg -f s16le -ar 48000 -ac 1 -i udp://0.0.0.0:5002 -t 5 /tmp/test.wav

# Listen live
ffplay -f s16le -ar 48000 -ac 1 udp://0.0.0.0:5002
```

## Boot behaviour

The service starts automatically on every boot via systemd (`WantedBy=multi-user.target`).

```
Power on → network up → audio_stream.service starts → udp_stream.py → FFmpeg → streaming
```

`udp_stream.py` is a Python watchdog: it monitors FFmpeg's stderr and auto-restarts it on any error. `Restart=always` in the unit file is a secondary failsafe.
