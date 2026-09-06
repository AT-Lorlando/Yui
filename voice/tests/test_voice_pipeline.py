"""Tests du pipeline voix (barge-in, fenêtre conversation, flux gapless,
vocabulaire). Sans GPU ni réseau ni enceinte — tout est faux sauf la logique.

Lancer :  python3 voice/tests/test_voice_pipeline.py
"""
from __future__ import annotations

import io
import os
import shutil
import struct
import sys
import tempfile
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
    pipe._last_echo_est = 0.0
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





# ── Garde anti-écho (double-talk) ────────────────────────────────────────────

def test_echo_gate():
    import importlib
    import echo as echo_mod
    importlib.reload(echo_mod)
    g = echo_mod.EchoGate()

    RATE, CH = 24000, 1280  # far à 24 kHz, chunks micro 80 ms @16 kHz
    t0 = 1000.0

    # Yui joue un motif d'énergie variable (parole simulée) pendant 6 s.
    g.on_stream_start(RATE)
    g._far_t0 = t0
    rng = np.random.default_rng(42)
    pattern = []
    for i in range(int(6 / echo_mod.SLICE_S)):
        loud = 4000 if (i // 5) % 2 == 0 else 300   # alternance parole/pause
        pattern.append(loud)
        g.feed_far((rng.standard_normal(int(RATE * echo_mod.SLICE_S)) * loud).astype(np.int16))

    # Le micro entend le même motif, retardé de 1,2 s, atténué ×0,5.
    DELAY = 1.2
    for i in range(int(6 / echo_mod.SLICE_S)):
        ts = t0 + DELAY + i * echo_mod.SLICE_S
        g.feed_mic((rng.standard_normal(1280) * pattern[i] * 0.5).astype(np.int16), now=ts)

    g.maybe_estimate(now=t0 + DELAY + 6)
    ok(g.delay_s is not None and abs(g.delay_s - DELAY) <= 0.2,
       f"écho: délai estimé ≈ 1,2 s (obtenu {g.delay_s})")
    ok(0.3 <= g.gain <= 0.8, f"écho: gain estimé ≈ 0,5 (obtenu {g.gain:.2f})")

    # Pendant une tranche forte : l'écho seul (mic ≈ 2000) est bloqué,
    # une vraie voix par-dessus (mic ≈ 6000) passe.
    loud_t = t0 + DELAY + 0.5 * echo_mod.SLICE_S  # au milieu d'une tranche forte
    ok(not g.allow_barge_in(2000, now=loud_t), "écho: Yui seule → barge-in bloqué")
    ok(g.allow_barge_in(6000, now=loud_t), "écho: voix par-dessus → barge-in permis")
    # Pendant une pause de Yui : tout passe.
    quiet_t = t0 + DELAY + 6 * echo_mod.SLICE_S  # tranche « pause » (i=6 → 300)
    ok(g.allow_barge_in(900, now=quiet_t), "écho: Yui en pause → garde ouverte")


# ── Corpus wake word ─────────────────────────────────────────────────────────

def test_wake_corpus():
    import importlib, wake_corpus
    tmpd = tempfile.mkdtemp(prefix="yui-corpus-")
    wake_corpus.WAKES_DIR = os.path.join(tmpd, "wakes")
    wake_corpus.SAMPLES_DIR = os.path.join(tmpd, "samples")
    os.makedirs(wake_corpus.WAKES_DIR)
    for n in ("wake-1.wav", "wake-2.wav"):
        open(os.path.join(wake_corpus.WAKES_DIR, n), "wb").write(b"RIFF")

    ok(wake_corpus.label_wake("/voice-debug/wakes/wake-1.wav", "false"),
       "corpus: faux wake accepté")
    ok(not os.path.exists(os.path.join(wake_corpus.WAKES_DIR, "wake-1.wav")),
       "corpus: faux wake retiré des archives")
    ok(os.path.exists(os.path.join(wake_corpus.SAMPLES_DIR, "negative", "wake-1.wav")),
       "corpus: faux wake dans negative/")

    ok(wake_corpus.label_wake("/voice-debug/wakes/wake-2.wav", "positive"),
       "corpus: vrai wake accepté")
    ok(os.path.exists(os.path.join(wake_corpus.WAKES_DIR, "wake-2.wav")),
       "corpus: vrai wake reste rejouable")
    ok(os.path.exists(os.path.join(wake_corpus.SAMPLES_DIR, "positive", "wake-2.wav")),
       "corpus: vrai wake copié dans positive/")

    ok(not wake_corpus.label_wake("/voice-debug/wakes/../../../etc/passwd", "false"),
       "corpus: traversée de chemin refusée")
    counts = wake_corpus.corpus_counts()
    ok(counts == {"positive": 1, "negative": 1}, f"corpus: compteurs {counts}")
    shutil.rmtree(tmpd)


# ── speak() du scheduler partage l'état de parole ────────────────────────────

def test_speak_shares_state():
    import speech_state, tts
    # Sans enceinte (__aucune_enceinte__), speak sort tôt SANS lever speaking.
    tts.speak("test")
    ok(not speech_state.speaking.is_set(), "speak: sans cast → pas d'état levé")
    # Les événements du serveur SONT ceux de speech_state (une seule vérité).
    import server
    ok(server._speaking is speech_state.speaking, "speak: état partagé (speaking)")
    ok(server._stop_event is speech_state.stop, "speak: état partagé (stop)")


if __name__ == "__main__":
    print("vocab:")
    test_vocab()
    print("flux gapless:")
    test_stream()
    print("barge-in / conversation:")
    test_barge_in_and_conversation()
    test_conversation_window_expires()
    print("garde anti-écho:")
    test_echo_gate()
    print("corpus wake word:")
    test_wake_corpus()
    print("speak partagé:")
    test_speak_shares_state()
    print(f"\nAll voice pipeline tests passed ({PASS} checks)")