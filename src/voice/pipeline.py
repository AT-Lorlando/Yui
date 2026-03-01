"""
Main voice pipeline:
  - VAD loop: captures speech segments from UDP, calls _process_utterance()
  - _process_utterance(): trigger detection → post_order()
  - post_order(): SSE streaming from orchestrator → sentence TTS → cast playback
  - _listen_for_stop(): parallel VAD during playback, sets _stop_event on stop word
"""
import json
import logging
import queue as _queue
import socket
import threading
import time

import numpy as np
import requests
import torch
from scipy import signal as _sig

from .asr import make_vad_iterator, rms, to_whisper, transcribe
from .config import (
    BEARER_TOKEN,
    CONVERSATION_WINDOW_S,
    FRAME_BYTES,
    LISTEN_PORT,
    MAX_UTTERANCE_S,
    MIN_UTTERANCE_S,
    PRE_BUFFER_BYTES,
    SAMPLE_RATE,
    SAMPLE_WIDTH,
    SILERO_CHUNK,
    SILERO_MIN_SILENCE_MS,
    SILERO_THRESHOLD,
    TRIGGER_WORD,
    YUI_STREAM_URL,
    YUI_URL,
)
from .speaker import is_user_voice
from .text_utils import (
    contains_stop_word,
    contains_trigger,
    find_sentence_end,
    strip_stop_words,
    strip_trigger,
)
from .tts import generate_tts, play_audio_blocking, play_chime

log = logging.getLogger("voice")

# ── Shared state ──────────────────────────────────────────────────────────────

_stop_event = threading.Event()  # set by stop-word listener to interrupt playback
_stop_utterance: str = ""        # full transcription that triggered the stop
_conversation_mode_until: float = 0.0


# ── Stop word listener ────────────────────────────────────────────────────────

def _eval_stop_utterance(speech_buf: bytes) -> None:
    """Transcribe a short utterance; set _stop_event if a stop word is found."""
    global _stop_utterance
    audio = to_whisper(speech_buf)
    # Use conversation prompt — trigger-word bias would interfere with stop words
    text = transcribe(audio, conversation_mode=True)
    if not text:
        log.info("[Stop listener] (empty — skipped)")
        return
    log.info(f"[Stop listener] heard: {text!r}")
    # Speaker check intentionally skipped: TTS voice never says "stop", and
    # checking would cause false rejections when voice mixes with Chromecast audio.
    if contains_stop_word(text):
        _stop_utterance = text
        _stop_event.set()
        log.info(f"Stop word detected: {text!r}")


def _listen_for_stop(sock: socket.socket, done: threading.Event) -> None:
    """
    Parallel VAD loop active only during TTS playback.
    Uses 500ms silence (vs 1200ms normal) — stop words are short, snappy phrases.
    """
    recv_buf = b""
    speech_buf = b""
    pre_buf = bytearray()
    recording = False
    silero_buf = np.array([], dtype=np.float32)
    vad_iter = make_vad_iterator(min_silence_ms=500)

    log.info("Stop word listener started")

    while not done.is_set() and not _stop_event.is_set():
        try:
            data, _ = sock.recvfrom(65535)
        except socket.timeout:
            continue
        except Exception as e:
            log.warning(f"Stop listener socket error: {e}")
            break

        recv_buf += data

        while (
            len(recv_buf) >= FRAME_BYTES
            and not done.is_set()
            and not _stop_event.is_set()
        ):
            frame = recv_buf[:FRAME_BYTES]
            recv_buf = recv_buf[FRAME_BYTES:]

            if not recording:
                pre_buf += frame
                if len(pre_buf) > PRE_BUFFER_BYTES:
                    pre_buf = pre_buf[-PRE_BUFFER_BYTES:]
            else:
                speech_buf += frame
                dur = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                if dur >= 5.0:  # hard cap — stop words are never this long
                    _eval_stop_utterance(speech_buf)
                    speech_buf = b""
                    recording = False
                    vad_iter = make_vad_iterator(min_silence_ms=500)
                    silero_buf = np.array([], dtype=np.float32)
                    continue

            samples_48k = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
            samples_16k = _sig.resample_poly(samples_48k, 1, 3).astype(np.float32)
            silero_buf = np.concatenate([silero_buf, samples_16k])

            while len(silero_buf) >= SILERO_CHUNK:
                chunk = torch.from_numpy(silero_buf[:SILERO_CHUNK])
                silero_buf = silero_buf[SILERO_CHUNK:]
                result = vad_iter(chunk)

                if result is not None:
                    if "start" in result and not recording:
                        speech_buf = bytes(pre_buf)
                        pre_buf = bytearray()
                        recording = True
                    elif "end" in result and recording:
                        dur = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                        if dur >= 0.3:
                            _eval_stop_utterance(speech_buf)
                        speech_buf = b""
                        recording = False
                        vad_iter = make_vad_iterator(min_silence_ms=500)
                        silero_buf = np.array([], dtype=np.float32)

    log.info("Stop word listener stopped")


# ── Orchestrator call — streaming ─────────────────────────────────────────────

def post_order(
    text: str,
    sock: socket.socket | None = None,
    reset_convo: bool = False,
) -> None:
    """
    Send the transcribed order to the orchestrator via SSE streaming.

    The LLM response is split into sentences as tokens arrive. Each sentence
    is dispatched to TTS in a background thread immediately, then played in
    arrival order (sentence N plays while N+1 is still synthesising).

    If sock is provided, a parallel stop-word listener runs during playback.
    Falls back to the blocking /order endpoint on any streaming error.
    reset_convo=True tells the orchestrator to clear its conversation history.
    """
    global _stop_utterance
    _stop_event.clear()
    _stop_utterance = ""
    log.info(f'Order ({"NEW convo" if reset_convo else "convo"}): "{text}"')

    # Ordered queue of TTS futures — each slot is filled by a worker thread
    play_queue: _queue.Queue = _queue.Queue()

    class _Slot:
        def __init__(self):
            self._q: _queue.Queue = _queue.Queue(maxsize=1)

        def put(self, val):
            self._q.put(val)

        def get(self):
            return self._q.get()

    def _tts_worker(sentence: str, slot: _Slot) -> None:
        try:
            slot.put(generate_tts(sentence))
        except Exception as e:
            log.error(f"TTS error ({sentence[:40]!r}): {e}")
            slot.put(None)

    def _flush(sentence: str) -> None:
        sentence = sentence.strip()
        if not sentence:
            return
        log.debug(f"TTS dispatch: {sentence[:60]!r}")
        slot = _Slot()
        play_queue.put(slot)
        threading.Thread(target=_tts_worker, args=(sentence, slot), daemon=True).start()

    def _sse_reader() -> None:
        buf = ""
        try:
            resp = requests.post(
                YUI_STREAM_URL,
                json={"order": text, "voice": True, "reset": reset_convo},
                headers={"Authorization": f"Bearer {BEARER_TOKEN}"},
                stream=True,
                timeout=90,
            )
            for raw in resp.iter_lines():
                if not raw:
                    continue
                line = raw.decode("utf-8")
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    if buf.strip():
                        _flush(buf)
                    break
                try:
                    obj = json.loads(data)
                    if "error" in obj:
                        log.error(f"Stream error: {obj['error']}")
                        break
                    token = obj.get("token", "")
                    if not token:
                        continue
                    buf += token
                    while True:
                        end = find_sentence_end(buf)
                        if end == -1:
                            break
                        _flush(buf[: end + 1])
                        buf = buf[end + 1 :].lstrip()
                except json.JSONDecodeError:
                    pass
        except Exception as e:
            log.error(f"SSE reader error: {e} — falling back to blocking call")
            try:
                resp2 = requests.post(
                    YUI_URL,
                    json={"order": text, "voice": True, "reset": reset_convo},
                    headers={"Authorization": f"Bearer {BEARER_TOKEN}"},
                    timeout=60,
                )
                response_text = resp2.json().get("response", "")
                if response_text:
                    _flush(response_text)
            except Exception as e2:
                log.error(f"Fallback also failed: {e2}")
        finally:
            play_queue.put(None)  # sentinel

    threading.Thread(target=_sse_reader, daemon=True).start()

    # Start stop-word listener in parallel (only when a socket is available)
    _stop_listener_done = threading.Event()
    if sock is not None:
        threading.Thread(
            target=_listen_for_stop, args=(sock, _stop_listener_done), daemon=True
        ).start()

    def _drain() -> None:
        while True:
            try:
                play_queue.get_nowait()
            except _queue.Empty:
                break

    # Playback loop — plays sentences in order on the calling thread.
    # Checks _stop_event every 100ms so interrupts register even during LLM thinking.
    while True:
        if _stop_event.is_set():
            _drain()
            break
        try:
            item = play_queue.get(timeout=0.1)
        except _queue.Empty:
            continue
        if item is None:
            break  # SSE reader sent sentinel
        if _stop_event.is_set():
            _drain()
            break
        result = item.get()  # blocks until TTS is ready for this sentence
        if result is None:
            continue
        audio, mime = result
        play_audio_blocking(audio, mime, _stop_event)
        if _stop_event.is_set():
            _drain()
            break

    _stop_listener_done.set()


# ── Utterance processing ──────────────────────────────────────────────────────

def _drain_udp(sock: socket.socket) -> None:
    """Discard buffered UDP packets to prevent the mic echo from re-triggering."""
    sock.settimeout(0.0)
    try:
        while True:
            sock.recvfrom(65535)
    except (BlockingIOError, socket.error):
        pass
    finally:
        sock.settimeout(0.5)


def _process_utterance(speech_buf: bytes, sock: socket.socket) -> None:
    """
    Transcribe a captured utterance and forward it to the orchestrator.
    Trigger word required in normal mode; optional in conversation mode.
    """
    global _conversation_mode_until

    in_convo = time.time() < _conversation_mode_until
    audio = to_whisper(speech_buf)
    text = transcribe(audio, conversation_mode=in_convo)

    log.info(
        f"Transcription: {text!r}"
        if text
        else "Transcription: (empty — Whisper found no speech)"
    )

    if not text:
        return

    if in_convo:
        order = strip_trigger(text) if contains_trigger(text) else text
        log.info(f"[Conversation mode] → Order: {order!r}")
    else:
        if not contains_trigger(text):
            log.info(f"No trigger word '{TRIGGER_WORD}' — ignored")
            return
        order = strip_trigger(text)
        if not order:
            log.info(f"Trigger found but nothing left after stripping: {text!r}")
            return
        log.info(f"→ Order: {order!r}")

    play_chime()  # fires immediately; LLM call starts in parallel
    post_order(order, sock=sock, reset_convo=not in_convo)

    if _stop_event.is_set():
        follow_up = strip_stop_words(_stop_utterance).strip()
        if follow_up:
            interrupt_msg = (
                f"L'utilisateur t'a interrompu(e) en disant : « {follow_up} ». "
                f"Réponds directement à ça, de façon concise."
            )
        else:
            interrupt_msg = (
                "L'utilisateur t'a interrompu(e) (il a dit « stop »). "
                "Demande-lui brièvement ce qu'il souhaite savoir."
            )
        log.info(f"Interrupted. Sending context: {interrupt_msg!r}")
        _drain_udp(sock)
        post_order(interrupt_msg, sock=sock, reset_convo=False)

    _conversation_mode_until = time.time() + CONVERSATION_WINDOW_S
    log.info(f"Conversation window: {CONVERSATION_WINDOW_S:.0f}s")
    _drain_udp(sock)


# ── Main VAD loop ─────────────────────────────────────────────────────────────

def main() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    sock.bind(("0.0.0.0", LISTEN_PORT))
    sock.settimeout(0.5)

    log.info(f"Listening for audio on UDP :{LISTEN_PORT}…")
    log.info(f"Trigger word: '{TRIGGER_WORD}' — say it anywhere in the sentence")
    log.info(
        f"Silero VAD: threshold={SILERO_THRESHOLD} "
        f"min_silence={SILERO_MIN_SILENCE_MS}ms"
    )

    recv_buf = b""
    speech_buf = b""
    pre_buf = bytearray()
    recording = False
    silero_buf = np.array([], dtype=np.float32)
    vad_iter = make_vad_iterator()

    # RMS monitoring stats — logged every 5s
    stat_frames = 0
    stat_sum = 0.0
    stat_max = 0.0
    STAT_INTERVAL = 250  # 250 × 20ms = 5s

    while True:
        try:
            data, _ = sock.recvfrom(65535)
        except socket.timeout:
            if recording and speech_buf:
                dur = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                if dur >= MIN_UTTERANCE_S:
                    _process_utterance(speech_buf, sock)
                speech_buf = b""
                recording = False
                vad_iter = make_vad_iterator()
                silero_buf = np.array([], dtype=np.float32)
            continue

        recv_buf += data

        while len(recv_buf) >= FRAME_BYTES:
            frame = recv_buf[:FRAME_BYTES]
            recv_buf = recv_buf[FRAME_BYTES:]

            # RMS stats (monitoring only)
            energy = rms(frame)
            stat_frames += 1
            stat_sum += energy
            stat_max = max(stat_max, energy)
            if stat_frames >= STAT_INTERVAL:
                avg = stat_sum / stat_frames
                log.info(
                    f"[RMS 5s] avg={avg:.0f}  max={stat_max:.0f}  recording={recording}"
                )
                stat_frames = 0
                stat_sum = 0.0
                stat_max = 0.0

            # Pre-buffer — always keep last 300ms before speech start
            if not recording:
                pre_buf += frame
                if len(pre_buf) > PRE_BUFFER_BYTES:
                    pre_buf = pre_buf[-PRE_BUFFER_BYTES:]
            else:
                speech_buf += frame
                dur = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                if dur >= MAX_UTTERANCE_S:
                    log.info(f"MAX_UTTERANCE reached ({dur:.1f}s) — forcing transcription")
                    _process_utterance(speech_buf, sock)
                    speech_buf = b""
                    recording = False
                    vad_iter = make_vad_iterator()
                    silero_buf = np.array([], dtype=np.float32)
                    pre_buf = bytearray()
                    continue

            # Resample 48kHz → 16kHz for Silero
            samples_48k = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
            samples_16k = _sig.resample_poly(samples_48k, 1, 3).astype(np.float32)
            silero_buf = np.concatenate([silero_buf, samples_16k])

            # Feed 512-sample chunks to Silero
            while len(silero_buf) >= SILERO_CHUNK:
                chunk = torch.from_numpy(silero_buf[:SILERO_CHUNK])
                silero_buf = silero_buf[SILERO_CHUNK:]
                result = vad_iter(chunk)

                if result is not None:
                    if "start" in result and not recording:
                        log.info("Recording started (Silero)")
                        speech_buf = bytes(pre_buf)
                        pre_buf = bytearray()
                        recording = True
                    elif "end" in result and recording:
                        dur = len(speech_buf) / (SAMPLE_RATE * SAMPLE_WIDTH)
                        log.info(f"Recording ended (Silero, {dur:.1f}s)")
                        if dur >= MIN_UTTERANCE_S:
                            _process_utterance(speech_buf, sock)
                        speech_buf = b""
                        recording = False
                        vad_iter = make_vad_iterator()
                        silero_buf = np.array([], dtype=np.float32)
                        pre_buf = bytearray()
