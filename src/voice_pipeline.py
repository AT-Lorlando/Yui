#!/usr/bin/env python3
"""
Yui Voice Pipeline — entry point.

Starts logging then imports the voice package (which loads Whisper, Silero VAD,
XTTS server connection, and the Chromecast) before running the main VAD loop.

Full pipeline:
  Raspberry Pi mic → UDP :5002 (s16le 48kHz)
    → Silero VAD → faster-whisper (CUDA) → trigger filter
    → POST /order/stream (orchestrator, SSE)
    → XTTS v2 (xtts_server.py) → WAV → Chromecast (Google Home Max)
"""
import logging
import os
import sys

# Configure logging before any voice module is imported (they log at import time)
_LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, _LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)

# Ensure the voice package is importable when running as `python src/voice_pipeline.py`
sys.path.insert(0, os.path.dirname(__file__))

from voice.pipeline import main  # noqa: E402 — logging must be configured first

if __name__ == "__main__":
    main()
