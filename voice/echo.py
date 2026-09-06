"""Garde anti-écho pour le barge-in (détection de double-talk).

Une AEC classique (Speex/WebRTC) exige un signal lointain aligné à quelques
dizaines de ms près — impossible ici : le chemin serveur → cast → enceinte →
pièce → micro Pi → UDP traverse ~1-3 s de tampon cast, variables. À la place,
on exploite ce qu'on SAIT : le PCM exact que Yui joue.

Principe (enveloppes d'énergie, pas d'annulation par échantillon) :
 1. `feed_far` — chaque PCM poussé dans le flux TTS alimente une enveloppe
    RMS (tranches de 80 ms) horodatée sur SA position dans le flux ;
 2. `feed_mic` — le micro alimente la sienne en temps réel ;
 3. le DÉLAI cast est estimé par corrélation croisée des deux enveloppes
    (une fois par lecture, mis en cache — il bouge peu) ;
 4. `allow_barge_in` — pendant que Yui parle, le wake n'est pris en compte
    que si l'énergie micro DÉPASSE nettement l'écho prédit (far décalé ×
    gain estimé) : la voix de Yui seule ne franchit jamais la garde, une
    vraie voix par-dessus la franchit.

Tout est pur/synchrone et testé avec des signaux synthétiques.
"""
from __future__ import annotations

import time
from collections import deque

import numpy as np

# Résolution des enveloppes — une tranche = un chunk OWW (80 ms @ 16 kHz).
SLICE_S = 0.08
# Plage de recherche du délai cast (s).
DELAY_MIN_S = 0.2
DELAY_MAX_S = 3.5
# L'écho prédit est multiplié par cette marge : en dessous → écho seul.
MARGIN = float(__import__('os').getenv('ECHO_GATE_MARGIN', '1.8'))
# Sous ce niveau d'écho prédit, la garde est ouverte (Yui quasi silencieuse).
FLOOR = 200.0


def rms(chunk_int16: np.ndarray) -> float:
    if len(chunk_int16) == 0:
        return 0.0
    return float(np.sqrt(np.mean(chunk_int16.astype(np.float64) ** 2)))


def estimate_delay(
    far: list[float],
    mic: list[float],
    slice_s: float = SLICE_S,
    lo_s: float = DELAY_MIN_S,
    hi_s: float = DELAY_MAX_S,
) -> tuple[float | None, float]:
    """Délai far→mic par corrélation croisée d'enveloppes. Pur.

    Renvoie (délai en s | None, qualité 0-1). None si signal insuffisant.
    """
    n = min(len(far), len(mic))
    if n < int(2.0 / slice_s):
        return None, 0.0
    f = np.asarray(far[:n], dtype=np.float64)
    m = np.asarray(mic[:n], dtype=np.float64)
    if f.std() < 1e-6 or m.std() < 1e-6:
        return None, 0.0
    f = (f - f.mean()) / f.std()
    m = (m - m.mean()) / m.std()
    lo, hi = int(lo_s / slice_s), min(int(hi_s / slice_s), n - 8)
    if hi <= lo:
        return None, 0.0
    best_lag, best_corr = None, 0.0
    for lag in range(lo, hi + 1):
        c = float(np.mean(f[: n - lag] * m[lag:n]))
        if c > best_corr:
            best_corr, best_lag = c, lag
    if best_lag is None or best_corr < 0.3:
        return None, best_corr
    return best_lag * slice_s, best_corr


class EchoGate:
    def __init__(self) -> None:
        # Enveloppe du signal joué, indexée par offset dans le flux.
        self._far: list[float] = []
        self._far_t0: float = 0.0
        self._far_tail = np.zeros(0, dtype=np.int16)
        self._far_rate = 24000
        # Enveloppe micro (fenêtre glissante ~8 s), horodatée.
        self._mic: deque[tuple[float, float]] = deque(maxlen=int(8 / SLICE_S))
        # Délai + gain appris — conservés d'une lecture à l'autre.
        self.delay_s: float | None = None
        self.gain: float = 1.0

    # ── Côté lecture (tts) ───────────────────────────────────────────────
    def on_stream_start(self, rate: int) -> None:
        self._far = []
        self._far_t0 = time.time()
        self._far_tail = np.zeros(0, dtype=np.int16)
        self._far_rate = rate

    def feed_far(self, pcm: np.ndarray) -> None:
        """Enveloppe RMS du PCM poussé (tranches de SLICE_S)."""
        if self._far_t0 == 0.0:
            self.on_stream_start(self._far_rate)
        buf = np.concatenate([self._far_tail, pcm])
        step = int(self._far_rate * SLICE_S)
        n = len(buf) // step
        for i in range(n):
            self._far.append(rms(buf[i * step : (i + 1) * step]))
        self._far_tail = buf[n * step :]

    # ── Côté micro (pipeline) ────────────────────────────────────────────
    def feed_mic(self, chunk_int16: np.ndarray, now: float | None = None) -> float:
        value = rms(chunk_int16)
        self._mic.append((now if now is not None else time.time(), value))
        return value

    # ── Estimation + garde ───────────────────────────────────────────────
    def _far_at(self, t: float) -> float:
        """Énergie jouée à l'instant t (selon la timeline du flux)."""
        if not self._far or self._far_t0 == 0.0:
            return 0.0
        idx = int((t - self._far_t0) / SLICE_S)
        if idx < 0 or idx >= len(self._far):
            return 0.0
        return self._far[idx]

    def maybe_estimate(self, now: float | None = None) -> None:
        """Tente d'estimer délai + gain — appelé périodiquement en lecture."""
        now = now if now is not None else time.time()
        if not self._far or len(self._mic) < int(3.0 / SLICE_S):
            return
        # Reconstruire deux enveloppes alignées sur la même horloge.
        mic_ts = [t for t, _ in self._mic]
        mic_v = [v for _, v in self._mic]
        start = mic_ts[0]
        far_v = [
            self._far_at(start + i * SLICE_S) for i in range(len(mic_v))
        ]
        delay, quality = estimate_delay(far_v, mic_v)
        if delay is not None:
            self.delay_s = delay
            # Gain : rapport médian mic/far sur les tranches où far est actif.
            pairs = [
                (m, f)
                for m, f in zip(mic_v[int(delay / SLICE_S) :], far_v)
                if f > FLOOR
            ]
            if len(pairs) >= 10:
                ratios = sorted(m / f for m, f in pairs)
                self.gain = ratios[len(ratios) // 2]

    def allow_barge_in(self, mic_rms: float, now: float | None = None) -> bool:
        """Le wake est-il crédible (vraie voix par-dessus l'écho) ?"""
        now = now if now is not None else time.time()
        if self.delay_s is None:
            # Pas encore calibré → ne pas bloquer le barge-in.
            return True
        expected = self._far_at(now - self.delay_s) * self.gain
        if expected < FLOOR:
            return True  # Yui quasi silencieuse à cet instant
        return mic_rms > expected * MARGIN


# Singleton process (tts et server partagent la même instance).
gate = EchoGate()
