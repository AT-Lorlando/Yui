"""UDP audio receiver with a thread-safe ring of int16 samples. Live software
gain is applied on read so tuning changes take effect immediately."""
from __future__ import annotations

import logging
import socket
import threading
from collections import deque
from typing import Callable

import numpy as np

log = logging.getLogger("voice")


class AudioSource:
    def __init__(self, port: int, get_gain: Callable[[], float]):
        self._port = port
        self._get_gain = get_gain
        self._buf = deque()                 # of np.int16 arrays
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._available = 0
        self._running = False
        self._thread: threading.Thread | None = None
        self._sock: socket.socket | None = None

    def _push(self, data: bytes) -> None:
        arr = np.frombuffer(data, dtype=np.int16)
        if len(arr) == 0:
            return
        with self._cond:
            self._buf.append(arr)
            self._available += len(arr)
            self._cond.notify_all()

    def read(self, n_samples: int) -> np.ndarray:
        with self._cond:
            while self._available < n_samples:
                self._cond.wait(timeout=5.0)
            out = np.empty(n_samples, dtype=np.int16)
            filled = 0
            while filled < n_samples:
                head = self._buf[0]
                take = min(len(head), n_samples - filled)
                out[filled:filled + take] = head[:take]
                if take == len(head):
                    self._buf.popleft()
                else:
                    self._buf[0] = head[take:]
                filled += take
                self._available -= take
        gain = self._get_gain()
        if gain != 1.0:
            scaled = np.clip(out.astype(np.int32) * gain, -32768, 32767)
            return scaled.astype(np.int16)
        return out

    def start(self) -> None:
        self._running = True
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
        self._sock.bind(("0.0.0.0", self._port))
        self._sock.settimeout(1.0)
        self._thread = threading.Thread(target=self._recv_loop, daemon=True)
        self._thread.start()
        log.info(f"AudioSource listening on UDP :{self._port}")

    def _recv_loop(self) -> None:
        while self._running:
            try:
                data, _ = self._sock.recvfrom(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            self._push(data)

    def stop(self) -> None:
        self._running = False
        if self._sock:
            self._sock.close()
