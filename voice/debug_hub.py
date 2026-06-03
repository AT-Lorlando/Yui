"""WebSocket hub for the front-end debug page.

Outbound (server->browser):
  {"type":"score","value":0.42,"threshold":0.5}        (always, when clients connected)
  {"type":"wake","ts":..,"score":..,"text":..,"wav":"/voice-debug/wakes/<file>"}
  binary frames: raw int16 PCM (only while a client requested "listen")
Inbound (browser->server):
  {"type":"tuning","threshold":0.6,"vad_aggressiveness":2,"gain":1.5}
  {"type":"listen","on":true}
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Callable

import numpy as np
import websockets

log = logging.getLogger("voice")


class DebugHub:
    def __init__(self, tuning, on_tuning_change: Callable[[], None], port: int):
        self._tuning = tuning
        self._on_tuning_change = on_tuning_change
        self._port = port
        self._clients: set = set()
        self._listeners: set = set()
        self._wakes: list[dict] = []          # recent wake events (most-recent last, cap 20)
        self._loop: asyncio.AbstractEventLoop | None = None

    # ---- called from the pipeline thread (thread-safe) ----
    def publish_score(self, score: float) -> None:
        self._schedule(self._broadcast_json, {
            "type": "score", "value": round(float(score), 4),
            "threshold": self._tuning.threshold,
        })

    def publish_audio(self, chunk_int16: np.ndarray) -> None:
        if not self._listeners:
            return
        self._schedule(self._broadcast_binary, chunk_int16.astype("<i2").tobytes())

    def record_wake(self, score: float, text: str, wav_url: str) -> None:
        evt = {"type": "wake", "ts": time.time(), "score": round(float(score), 3),
               "text": text, "wav": wav_url}
        self._wakes.append(evt)
        self._wakes = self._wakes[-20:]
        self._schedule(self._broadcast_json, evt)

    def _schedule(self, fn, arg) -> None:
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(fn(arg)))

    # ---- asyncio side ----
    async def _broadcast_json(self, obj) -> None:
        msg = json.dumps(obj)
        await asyncio.gather(*[c.send(msg) for c in list(self._clients)], return_exceptions=True)

    async def _broadcast_binary(self, data) -> None:
        await asyncio.gather(*[c.send(data) for c in list(self._listeners)], return_exceptions=True)

    async def _handler(self, ws) -> None:
        self._clients.add(ws)
        try:
            await ws.send(json.dumps({"type": "tuning", **self._tuning.to_dict()}))
            for evt in self._wakes:
                await ws.send(json.dumps(evt))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if msg.get("type") == "tuning":
                    self._tuning.update(
                        threshold=msg.get("threshold"),
                        vad_aggressiveness=msg.get("vad_aggressiveness"),
                        gain=msg.get("gain"),
                        send_to_ai=msg.get("send_to_ai"),
                    )
                    self._on_tuning_change()
                    await self._broadcast_json({"type": "tuning", **self._tuning.to_dict()})
                elif msg.get("type") == "listen":
                    if msg.get("on"):
                        self._listeners.add(ws)
                    else:
                        self._listeners.discard(ws)
        finally:
            self._clients.discard(ws)
            self._listeners.discard(ws)

    async def serve(self) -> None:
        self._loop = asyncio.get_event_loop()
        async with websockets.serve(self._handler, "0.0.0.0", self._port, max_size=2**20):
            log.info(f"DebugHub WebSocket on :{self._port}")
            await asyncio.Future()            # run forever
