#!/usr/bin/env python3
"""
Yui Voice Satellite — Raspberry Pi
===================================
Runs on the Pi with the ReSpeaker XVF3800.
- Reads mono audio from ReSpeaker via PipeWire (downmix of all beams)
- OpenWakeWord wake word detection (local, trained model, ~3% CPU)
- On wake: streams audio via WebSocket to the server
- webrtcvad detects end of speech → stops streaming
- Receives server response (TTS playback status)

Dependencies:
    pip install openwakeword==0.4.0 onnxruntime numpy websocket-client webrtcvad
    (arecord is provided by alsa-utils — sudo apt install alsa-utils)

Usage:
    python main.py --server ws://10.0.0.101:5050 --model assets/wakeword/yui.onnx
"""

from __future__ import annotations  # allows list[str] | None on Python 3.9+

import argparse
import json
import logging
import os
import queue
import struct
import sys
import threading
import time
from pathlib import Path

import subprocess

import numpy as np
import webrtcvad

from wakeword import WakeWordEngine, OWW_CHUNK

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16000
CHANNELS = 1              # mono — PipeWire downmixes all ReSpeaker mics

# OpenWakeWord processes fixed-size frames (1280 samples / 80 ms at 16kHz)
WAKE_FRAME = OWW_CHUNK

# VAD config
VAD_AGGRESSIVENESS = 2          # webrtcvad: 0 (least) to 3 (most aggressive)
VAD_FRAME_MS = 30               # webrtcvad supports 10, 20, or 30 ms frames
VAD_FRAME_SAMPLES = SAMPLE_RATE * VAD_FRAME_MS // 1000   # 480 samples
VAD_MIN_SPEECH_MS = 300         # minimum speech to consider valid utterance
VAD_SILENCE_TIMEOUT_MS = 1200   # silence after speech = end of utterance
MAX_UTTERANCE_S = 15            # safety cap

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("yui-satellite")

# ---------------------------------------------------------------------------
# Audio device helpers
# ---------------------------------------------------------------------------

def find_alsa_device(hint: str | None = None) -> str:
    """
    Find the ALSA capture device for the ReSpeaker XVF3800.
    Returns an ALSA device string like 'hw:1,0'.
    Uses `arecord -l` to discover the card number.
    """
    if hint:
        return hint
    try:
        out = subprocess.check_output(["arecord", "-l"], text=True, stderr=subprocess.DEVNULL)
        for line in out.splitlines():
            low = line.lower()
            if "respeaker" in low or "xvf3800" in low or "array" in low:
                # e.g. "card 1: Array [reSpeaker XVF3800 ...], device 0: ..."
                import re
                m = re.search(r"card (\d+).*device (\d+)", line)
                if m:
                    device = f"hw:{m.group(1)},{m.group(2)}"
                    log.info(f"Found ReSpeaker via arecord: {device} ({line.strip()})")
                    return device
    except Exception as e:
        log.warning(f"arecord -l failed: {e}")
    log.warning("ReSpeaker not found by name — falling back to hw:1,0")
    return "hw:1,0"


# ---------------------------------------------------------------------------
# VAD — webrtcvad (lightweight, no torch, works on ARM Pi 3)
# ---------------------------------------------------------------------------

class VoiceActivityDetector:
    """
    webrtcvad-based end-of-speech detector.
    Works on 16kHz int16 mono PCM frames of exactly 10, 20, or 30 ms.
    """

    def __init__(self, aggressiveness: int = VAD_AGGRESSIVENESS):
        self.vad = webrtcvad.Vad(aggressiveness)
        self.frame_bytes = VAD_FRAME_SAMPLES * 2  # int16 = 2 bytes/sample
        log.info(f"webrtcvad ready (aggressiveness={aggressiveness})")

    def is_speech(self, pcm_int16: np.ndarray) -> bool:
        """
        Check if a VAD_FRAME_SAMPLES-sample chunk contains speech.
        If the array is larger, only the first VAD_FRAME_SAMPLES samples are used.
        """
        frame = pcm_int16[:VAD_FRAME_SAMPLES]
        if len(frame) < VAD_FRAME_SAMPLES:
            # Pad with zeros rather than skipping
            frame = np.pad(frame, (0, VAD_FRAME_SAMPLES - len(frame)))
        try:
            return self.vad.is_speech(frame.tobytes(), SAMPLE_RATE)
        except Exception:
            return False

    def reset(self) -> None:
        pass  # webrtcvad is stateless per-frame


# ---------------------------------------------------------------------------
# WebSocket client to Yui server
# ---------------------------------------------------------------------------

class ServerConnection:
    def __init__(self, server_url: str):
        self.server_url = server_url
        self.ws = None
        self._lock = threading.Lock()

    def connect(self) -> bool:
        import websocket
        try:
            self.ws = websocket.create_connection(
                self.server_url,
                timeout=5,
                header={"X-Client": "yui-satellite"},
            )
            log.info(f"Connected to server: {self.server_url}")
            return True
        except Exception as e:
            log.error(f"Server connection failed: {e}")
            self.ws = None
            return False

    def ensure_connected(self) -> bool:
        with self._lock:
            if self.ws is None:
                return self.connect()
            try:
                self.ws.ping()
                return True
            except Exception:
                self.ws = None
                return self.connect()

    def send_wake(self) -> None:
        self._send_json({"type": "wake", "timestamp": time.time()})

    def send_audio(self, pcm_int16: np.ndarray) -> None:
        if self.ws:
            try:
                self.ws.send(pcm_int16.tobytes(), opcode=0x2)  # binary frame
            except Exception as e:
                log.error(f"Audio send failed: {e}")
                self.ws = None

    def send_end(self) -> None:
        self._send_json({"type": "end", "timestamp": time.time()})

    def receive_response(self, timeout: float = 30.0) -> dict | None:
        if not self.ws:
            return None
        try:
            self.ws.settimeout(timeout)
            data = self.ws.recv()
            if isinstance(data, str):
                return json.loads(data)
        except Exception as e:
            log.error(f"Receive failed: {e}")
        return None

    def _send_json(self, obj: dict) -> None:
        if self.ws:
            try:
                self.ws.send(json.dumps(obj))
            except Exception as e:
                log.error(f"JSON send failed: {e}")
                self.ws = None

    def close(self) -> None:
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None


# ---------------------------------------------------------------------------
# Main satellite loop
# ---------------------------------------------------------------------------

class YuiSatellite:
    # Bytes per wake frame: 1280 samples × 1 channel × 2 bytes/sample
    _FRAME_BYTES = WAKE_FRAME * CHANNELS * 2

    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.running = False

        self.wake_engine = WakeWordEngine(
            model_path=args.model,
            threshold=args.threshold,
        )
        self.vad = VoiceActivityDetector(aggressiveness=args.vad_aggressiveness)
        self.server = ServerConnection(args.server)
        self.alsa_device = find_alsa_device(args.alsa_device)

    def _open_arecord(self) -> subprocess.Popen:
        """
        Capture mono 16kHz s16le raw PCM via arecord, reading the ReSpeaker
        ALSA device directly (plughw) rather than the PipeWire 'default' node.

        The PipeWire 'default' path was found to mangle the signal (resampling /
        downmix artifacts), collapsing wake-word scores to ~0 even on loud,
        clean speech. Reading the card directly at its native 16 kHz yields
        clean audio (verified: same utterance scores 0.98+ vs ~0.1 via default).
        plughw downmixes the card's stereo capture (the XVF3800 exposes a 2nd,
        silent channel) to the mono the wake-word engine expects.
        """
        dev = self.alsa_device
        if dev.startswith("hw:"):
            dev = "plug" + dev          # hw:1,0 -> plughw:1,0 (enables downmix)
        cmd = [
            "arecord",
            "-D", dev,
            "-f", "S16_LE",
            f"-r", str(SAMPLE_RATE),
            f"-c", str(CHANNELS),
            "-t", "raw",
            "-q",               # suppress status messages on stderr
        ]
        log.info(f"Opening audio: {' '.join(cmd)}")
        return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def run(self) -> None:
        self.running = True
        log.info(f"Starting Yui satellite (ALSA device={self.alsa_device})")
        self.server.ensure_connected()

        proc = self._open_arecord()
        wake_buf = np.zeros(0, dtype=np.int16)

        log.info("Listening for wake word…")
        try:
            while self.running:
                chunk = proc.stdout.read(self._FRAME_BYTES)
                if not chunk:
                    log.error("arecord stream ended unexpectedly")
                    break

                mono = np.frombuffer(chunk, dtype=np.int16)
                wake_buf = np.concatenate([wake_buf, mono])

                while len(wake_buf) >= WAKE_FRAME:
                    frame = wake_buf[:WAKE_FRAME]
                    wake_buf = wake_buf[WAKE_FRAME:]

                    if self.wake_engine.process(frame):
                        log.info("🎤 Wake word detected!")
                        self._handle_utterance(proc)
                        # Flush buffers so the just-handled audio can't re-fire.
                        self.wake_engine.reset()
                        wake_buf = np.zeros(0, dtype=np.int16)
                        log.info("Listening for wake word…")
        finally:
            proc.terminate()
            proc.wait()

    def _handle_utterance(self, proc: subprocess.Popen) -> None:
        """After wake word: stream audio to server until end of speech."""
        if not self.server.ensure_connected():
            log.error("Cannot reach server — dropping utterance")
            return

        self.server.send_wake()
        self.vad.reset()

        speech_started = False
        silence_frames = 0
        speech_frames = 0
        total_frames = 0
        vad_buf = np.zeros(0, dtype=np.int16)

        max_frames = int(MAX_UTTERANCE_S * SAMPLE_RATE / WAKE_FRAME)
        silence_limit = int(VAD_SILENCE_TIMEOUT_MS / VAD_FRAME_MS)
        speech_min = int(VAD_MIN_SPEECH_MS / VAD_FRAME_MS)

        while self.running and total_frames < max_frames:
            chunk = proc.stdout.read(self._FRAME_BYTES)
            if not chunk:
                break

            mono = np.frombuffer(chunk, dtype=np.int16)
            total_frames += 1
            self.server.send_audio(mono)

            # webrtcvad on 30ms frames
            vad_buf = np.concatenate([vad_buf, mono])
            is_speech = False
            while len(vad_buf) >= VAD_FRAME_SAMPLES:
                is_speech = self.vad.is_speech(vad_buf[:VAD_FRAME_SAMPLES])
                vad_buf = vad_buf[VAD_FRAME_SAMPLES:]

            if is_speech:
                speech_started = True
                speech_frames += 1
                silence_frames = 0
            elif speech_started:
                silence_frames += 1
                if silence_frames >= silence_limit and speech_frames >= speech_min:
                    log.info(
                        f"End of speech ({speech_frames} speech frames, "
                        f"{total_frames} total)"
                    )
                    break

        self.server.send_end()

        # Wait for server to finish TTS before re-entering wake word detection
        response = self.server.receive_response(timeout=60.0)
        if response:
            status = response.get("status", "unknown")
            text = response.get("text", "")
            log.info(f"Server: status={status}" + (f', text="{text}"' if text else ""))

    def stop(self) -> None:
        self.running = False
        self.wake_engine.cleanup()
        self.server.close()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Yui Voice Satellite")
    parser.add_argument(
        "--server", default="ws://10.0.0.101:5050",
        help="WebSocket URL of Yui server",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("WAKEWORD_MODEL", "assets/wakeword/yui.onnx"),
        help="Path to the trained OpenWakeWord .onnx model",
    )
    parser.add_argument(
        "--threshold", type=float,
        default=float(os.getenv("WAKEWORD_THRESHOLD", "0.5")),
        help="Wake word score threshold 0.0–1.0 (default: 0.5)",
    )
    parser.add_argument(
        "--vad-aggressiveness", type=int, default=VAD_AGGRESSIVENESS,
        choices=[0, 1, 2, 3],
        help=f"webrtcvad aggressiveness 0–3 (default: {VAD_AGGRESSIVENESS})",
    )
    parser.add_argument(
        "--alsa-device", default=None,
        help="ALSA capture device (e.g. hw:1,0). Auto-detected via arecord -l if omitted.",
    )
    args = parser.parse_args()

    satellite = YuiSatellite(args)
    try:
        satellite.run()
    except KeyboardInterrupt:
        log.info("Shutting down…")
    finally:
        satellite.stop()


if __name__ == "__main__":
    main()
