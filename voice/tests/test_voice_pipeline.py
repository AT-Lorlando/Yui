"""Tests du pipeline voix (barge-in, fenêtre conversation, flux gapless,
vocabulaire). Sans GPU ni réseau ni enceinte — tout est faux sauf la logique.

Lancer :  python3 voice/tests/test_voice_pipeline.py
"""
from __future__ import annotations

import io
import os
import struct
import sys
import threading
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("CONVERSATION_WINDOW_S", "2")
os.environ["TTS_PORT"] = "18971"
os.environ["SPEAK_PORT"] = "18972"
os.environ["TTS_SPEAKER"] = "__aucune_enceinte__"

PASS = 0


def ok(cond, label):
    global PASS
    assert cond, label
    PASS += 1
    print(f"  ✓ {label}")


# ── vocab.build_prompt ───────────────────────────────────────────────────────

def test_vocab():
    from vocab import build_prompt

    base = "Transcription en français."
    ok(build_prompt(base, []) == base, "vocab: sans mots → base seule")
    p = build_prompt(base, ["Salon", "Mentalist", "salon", "", "WiiM"])
    ok("Mots du foyer : Salon, Mentalist, WiiM." in p, "vocab: dédup + assemblage")
    long_words = [f"Lampe{i}" for i in range(200)]
    p2 = build_prompt(base, long_words, max_chars=60)
    ok(len(p2) < len(base) + 90, "vocab: borné en longueur")


# ── stream_wav_header / PcmStream ────────────────────────────────────────────

def test_stream():
    # tts importe pychromecast + ouvre des ports — on teste les briques pures
    # en les recopiant depuis le module sans l'importer entièrement ?
    # Non : import réel, mais ports détournés pour ne pas heurter la prod.
    import tts

    hdr = tts.stream_wav_header(24000)
    ok(hdr[:4] == b"RIFF" and hdr[8:12] == b"WAVE", "stream: en-tête RIFF/WAVE")
    rate = struct.unpack_from("<I", hdr, 24)[0]
    ok(rate == 24000, "stream: sample rate dans l'en-tête")
    ok(struct.unpack_from("<I", hdr, 4)[0] == 0xFFFFFFFF, "stream: taille infinie")

    s = tts.PcmStream(24000)
    s.push(np.zeros(24000, dtype=np.int16))     # 1 s
    s.push_gap(500)                              # 0,5 s
    ok(abs(s.pushed_s - 1.5) < 0.01, "stream: durée poussée comptée")
    s.close()
    ok(s.q.get() is not None and s.q.get() is not None and s.q.get() is None,
       "stream: close → sentinelle en fin de file")

    # wav_to_pcm : un vrai petit WAV
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, np.zeros((100, 2), dtype=np.int16), 24000, format="WAV")
    pcm, r = tts.wav_to_pcm(buf.getvalue())
    ok(r == 24000 and len(pcm) == 100 and pcm.ndim == 1, "stream: wav→pcm mono")


# ── barge-in + fenêtre conversation (machine à états de server.py) ──────────

class FakeSource:
    """AudioSource factice : silence en continu, drain compté."""

    def __init__(self):
        self.drains = 0

    def read(self, n):
        time.sleep(0.005)
        return np.zeros(n, dtype=np.int16)

    def drain(self):
        self.drains += 1

    def start(self):
        pass

    def stop(self):
        pass


class FakeWake:
    """Score piloté par le test."""

    def __init__(self):
        self.value = 0.0

    def score(self, _):
        return self.value

    def reset(self):
        self.value = 0.0


class FakeHub:
    def publish_audio(self, _):
        pass

    def publish_score(self, _):
        pass

    def record_wake(self, *a):
        pass


def test_barge_in_and_conversation():
    import server

    # Neutraliser les effets de bord
    server.play_chime = lambda: None
    orders: list[str] = []

    def fake_post_order(text, reset_convo=False):
        server._stop_event.clear()
        orders.append(text)
        server._speaking.set()
        # « Yui parle » pendant 1 s max, interruptible
        server._stop_event.wait(timeout=1.0)
        server._speaking.clear()
        server._conversation_mode_until = time.time() + server.CONVERSATION_WINDOW_S

    server._post_order = fake_post_order

    class FakeStt:
        text = "allume le salon"

        def transcribe(self, _audio, initial_prompt=None):
            return self.text

    class InstantCapture:
        """Renvoie une utterance dès le premier feed."""

        started = False

        def reset(self):
            pass

        def feed(self, _):
            return np.ones(16000, dtype=np.int16)

    from tuning import VoiceTuning
    tuning = VoiceTuning()
    pipe = server.VoicePipeline.__new__(server.VoicePipeline)
    pipe.stt = FakeStt()
    pipe.hub = FakeHub()
    pipe.tuning = tuning
    pipe.source = FakeSource()
    pipe.wake = FakeWake()
    pipe.running = False
    pipe._speaker = None
    pipe._new_capture = lambda: InstantCapture()

    pipe.running = True
    t = threading.Thread(target=pipe.run, daemon=True)
    t.start()
    time.sleep(0.1)

    # 1. Wake normal → ordre capté, _post_order lancé en thread (non bloquant)
    pipe.wake.value = 0.9
    time.sleep(0.15)
    pipe.wake.value = 0.0
    time.sleep(0.2)
    ok(orders == ["allume le salon"], "wake → ordre transmis")
    ok(server._speaking.is_set(), "pendant la réponse : _speaking actif")

    # 2. Barge-in : « Yui » pendant la lecture → interruption + nouvel ordre
    pipe.stt.text = "éteins tout"
    pipe.wake.value = 0.95
    time.sleep(0.25)
    pipe.wake.value = 0.0
    time.sleep(0.4)
    ok(orders[-1] == "éteins tout", "barge-in → lecture coupée, nouvel ordre")
    ok(pipe.source.drains >= 1, "barge-in → tampon audio purgé")

    # 3. Attendre la fin de la seconde réponse → fenêtre conversation ouverte
    for _ in range(40):
        if not server._speaking.is_set():
            break
        time.sleep(0.05)
    time.sleep(0.15)
    ok(time.time() < server._conversation_mode_until,
       "fin de réponse → fenêtre conversation ouverte")

    # 4. En fenêtre : parler SANS wake word → ordre transmis
    pipe.stt.text = "mets de la musique"
    time.sleep(0.3)
    ok("mets de la musique" in orders, "fenêtre conversation : ordre sans wake word")

    pipe.running = False
    server._stop_event.set()
    time.sleep(0.1)


def test_conversation_window_expires():
    """Fenêtre expirée sans parole → la capture rend la main (pas de blocage)."""
    import server

    class NeverSpeaksCapture:
        started = False

        def reset(self):
            pass

        def feed(self, _):
            return None

    pipe = server.VoicePipeline.__new__(server.VoicePipeline)
    pipe.hub = FakeHub()
    pipe.source = FakeSource()
    pipe.running = True
    pipe._new_capture = lambda: NeverSpeaksCapture()
    server._conversation_mode_until = time.time() + 0.3

    t0 = time.time()
    pipe._capture_and_handle(conversation=True)
    elapsed = time.time() - t0
    ok(elapsed < 1.5, f"fenêtre expirée → capture rend la main ({elapsed:.2f}s)")


if __name__ == "__main__":
    print("vocab:")
    test_vocab()
    print("flux gapless:")
    test_stream()
    print("barge-in / conversation:")
    test_barge_in_and_conversation()
    test_conversation_window_expires()
    print(f"\nAll voice pipeline tests passed ({PASS} checks)")
