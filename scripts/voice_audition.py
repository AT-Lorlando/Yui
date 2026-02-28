#!/usr/bin/env python3
"""
Voice Audition Script — Finalists
===================================
Plays a French test sentence through each shortlisted XTTS voice on the
configured Chromecast speaker so you can pick the final one.

Usage:
    python scripts/voice_audition.py

Controls:
    Enter  → play next voice
    y      → mark as favourite (printed at the end)
    p      → replay current voice
    q      → quit

Environment:
    XTTS_SERVER_URL  — XTTS server base URL (default: http://localhost:18770)
    TTS_SPEAKER      — Chromecast device name (default: Salon)
    LOCAL_IP         — This machine's LAN IP (default: 10.0.0.101)
    TTS_PORT         — Local HTTP server port (default: 18766)
    AUDITION_SPEED   — Playback speed (default: 1.0)
"""

import os
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pychromecast
import requests

# ── Config ────────────────────────────────────────────────────────────────────
XTTS_URL       = os.getenv("XTTS_SERVER_URL", "http://localhost:18770")
CAST_TARGET    = os.getenv("TTS_SPEAKER", "Salon")
LOCAL_IP       = os.getenv("LOCAL_IP", "10.0.0.101")
TTS_PORT       = int(os.getenv("TTS_PORT", "18766"))
AUDITION_SPEED = float(os.getenv("AUDITION_SPEED", "1.0"))

# A sentence that exercises French phonemes: nasals, liaisons, accents, numbers
AUDITION_TEXT = (
    "Bonjour Jérémy, il est huit heures trente. "
    "Aujourd'hui vous avez trois réunions et la météo annonce du soleil, "
    "avec une température maximale de vingt-deux degrés. "
    "Est-ce que je peux faire autre chose pour vous ?"
)

# ── Shortlisted voices ────────────────────────────────────────────────────────
VOICES = [
    "Chandra MacFarland",
    "Lilya Stainthorpe",
    "Narelle Moon",
    "Ige Behringer",
    "Damjan Chapman",
    "Aaron Dreschner",
    "Kumar Dahl",
    "Vjollca Johnnie",
]

# ── Tiny HTTP server to serve WAV to the Chromecast ──────────────────────────
_audio_data: bytes = b""
_audio_lock = threading.Lock()


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        with _audio_lock:
            data = _audio_data
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


httpd = ThreadingHTTPServer(("0.0.0.0", TTS_PORT), _Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()


# ── WAV duration ──────────────────────────────────────────────────────────────
def wav_duration(data: bytes) -> float:
    try:
        idx = data.find(b"data", 12)
        if idx == -1:
            return 4.0
        data_size   = struct.unpack_from("<I", data, idx + 4)[0]
        channels    = struct.unpack_from("<H", data, 22)[0]
        sample_rate = struct.unpack_from("<I", data, 24)[0]
        bps         = struct.unpack_from("<H", data, 34)[0] // 8
        if bps == 0 or channels == 0 or sample_rate == 0:
            return 4.0
        return (data_size // (bps * channels)) / sample_rate
    except Exception:
        return 4.0


# ── Playback ──────────────────────────────────────────────────────────────────
def play_wav(cast: pychromecast.Chromecast, audio: bytes) -> None:
    global _audio_data
    with _audio_lock:
        _audio_data = audio

    url = f"http://{LOCAL_IP}:{TTS_PORT}/tts.wav?t={int(time.time() * 1000)}"
    mc = cast.media_controller
    mc.play_media(url, "audio/wav")
    mc.block_until_active(timeout=10)

    duration = wav_duration(audio)
    # Phase 1: unconditional sleep for most of the duration
    time.sleep(max(0.1, duration - 0.5))
    # Phase 2: poll until done
    deadline = time.time() + 2.0
    while time.time() < deadline:
        state = getattr(mc.status, "player_state", None)
        if state not in ("PLAYING", "BUFFERING"):
            break
        time.sleep(0.1)
    time.sleep(0.3)


# ── Synthesise ────────────────────────────────────────────────────────────────
def synthesise(speaker: str) -> bytes | None:
    try:
        r = requests.post(
            f"{XTTS_URL}/tts",
            json={"text": AUDITION_TEXT, "language": "fr", "speaker": speaker, "speed": AUDITION_SPEED},
            timeout=30,
        )
        r.raise_for_status()
        return r.content
    except Exception as e:
        print(f"  [TTS error: {e}]")
        return None


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    # Verify XTTS server is reachable
    try:
        requests.get(f"{XTTS_URL}/health", timeout=5).raise_for_status()
    except Exception as e:
        print(f"ERROR: Cannot reach XTTS server at {XTTS_URL}: {e}")
        sys.exit(1)

    print(f"XTTS server: OK — testing {len(VOICES)} finalist voices")

    # Discover Chromecast
    # Stop discovery AFTER cast.wait() so zeroconf stays alive during the
    # connection handshake (stopping it early causes AssertionError in socket_client).
    print(f"Discovering '{CAST_TARGET}' on the network…")
    chromecasts, browser = pychromecast.get_chromecasts(timeout=12)
    device = next((cc for cc in chromecasts if cc.name.lower() == CAST_TARGET.lower()), None)
    if not device:
        pychromecast.discovery.stop_discovery(browser)
        print(f"ERROR: Cast device '{CAST_TARGET}' not found. Check TTS_SPEAKER env.")
        sys.exit(1)
    host, port = device.cast_info.host, device.cast_info.port
    cast = pychromecast.get_chromecast_from_host((host, port, None, None, CAST_TARGET))
    cast.wait()
    pychromecast.discovery.stop_discovery(browser)  # safe to stop now
    print(f"Connected to '{cast.name}'\n")

    print(f'Text: "{AUDITION_TEXT}"')
    print(f"Speed: {AUDITION_SPEED}x\n")
    print("Controls:  Enter=play  y=favourite  p=replay  q=quit")
    print("─" * 60)

    favourites: list[str] = []
    last_audio: bytes | None = None
    i = 0

    while i < len(VOICES):
        speaker = VOICES[i]
        print(f"\n[{i + 1}/{len(VOICES)}] {speaker}")

        cmd = input("  → Enter / y / p / q : ").strip().lower()

        if cmd == "q":
            break

        if cmd == "p":
            if last_audio:
                print("  Replaying…")
                play_wav(cast, last_audio)
            continue  # don't advance

        print("  Generating…", end=" ", flush=True)
        audio = synthesise(speaker)
        if audio is None:
            i += 1
            continue

        last_audio = audio
        print(f"Playing ({wav_duration(audio):.1f}s)…")
        play_wav(cast, audio)

        if cmd == "y":
            favourites.append(speaker)
            print("  ★ Marked as favourite")

        i += 1

    print("\n" + "═" * 60)
    if favourites:
        print("Favourite voices:")
        for v in favourites:
            print(f"  ★  {v}")
        print(f'\nTo use, set in your .env:\n  XTTS_SPEAKER="{favourites[0]}"')
    else:
        print("No favourites marked.")


if __name__ == "__main__":
    main()
