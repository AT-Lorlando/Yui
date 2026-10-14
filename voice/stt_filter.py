"""Filtre des hallucinations Whisper (14/10/2026).

Sur du bruit ou un faux réveil, Whisper « transcrit » les génériques de
sous-titres qu'il a appris sur les vidéos : « Sous-titrage ST' 501 »,
« Sous-titres réalisés par la communauté d'Amara.org », « Merci d'avoir
regardé »… Ces textes partaient au LLM comme de vrais ordres (3 ordres sur
14 en octobre 2026). Deux étages, purs et testables :

- texte : un générique de sous-titres rejette TOUTE l'utterance (aucun
  ordre réel ne contient « sous-titrage ») ; une formule de politesse
  (« à bientôt ») ne rejette que si l'énoncé se réduit à elle ;
- statistiques des segments : `no_speech_prob` pondéré par la durée,
  `avg_logprob` moyen et `compression_ratio` (répétitions).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Optional

# Génériques : rejet de l'énoncé entier dès qu'ils apparaissent.
CREDITS_PATTERNS = [
    re.compile(r"sous[\s-]*titr", re.I),            # sous-titres, sous-titrage, soustitrage
    re.compile(r"\bST['’]?\s*\d{3}\b"),               # ST' 501
    re.compile(r"amara\.?org", re.I),
    re.compile(r"radio[\s-]*canada", re.I),
    re.compile(r"merci d'avoir regard", re.I),
    re.compile(r"abonnez[\s-]*vous", re.I),
    re.compile(r"\blikez\b", re.I),
    re.compile(r"\bsubtitles?\b", re.I),
]

# Formules : rejet seulement si l'énoncé n'est (presque) que ça.
FAREWELL_PATTERNS = [
    re.compile(r"merci de votre attention", re.I),
    re.compile(r"à bientôt", re.I),
    re.compile(r"\bmerci\b", re.I),
]

_WORD_RE = re.compile(r"[\wÀ-ÿ']+")


@dataclass
class SegmentStats:
    """Agrégat des statistiques faster-whisper d'une utterance."""

    segments: int = 0
    duration: float = 0.0
    no_speech: float = 0.0       # pondéré par la durée
    logprob: float = 0.0         # pondéré par la durée
    compression: float = 0.0     # max
    temperature: float = 0.0     # max (fallback déclenché si > 0)

    def summary(self) -> str:
        return (
            f"seg={self.segments} dur={self.duration:.1f}s ns={self.no_speech:.2f} "
            f"lp={self.logprob:.2f} cr={self.compression:.2f} t={self.temperature:.1f}"
        )


def collect_stats(segments: Iterable[object]) -> SegmentStats:
    """Duck-typé : chaque segment expose start/end/no_speech_prob/avg_logprob/compression_ratio."""
    st = SegmentStats()
    ns = lp = 0.0
    for s in segments:
        dur = max(0.05, float(getattr(s, "end", 0.0)) - float(getattr(s, "start", 0.0)))
        st.segments += 1
        st.duration += dur
        ns += dur * float(getattr(s, "no_speech_prob", 0.0))
        lp += dur * float(getattr(s, "avg_logprob", 0.0))
        st.compression = max(st.compression, float(getattr(s, "compression_ratio", 0.0)))
        st.temperature = max(st.temperature, float(getattr(s, "temperature", 0.0) or 0.0))
    if st.duration > 0:
        st.no_speech = ns / st.duration
        st.logprob = lp / st.duration
    return st


def text_reason(text: str) -> Optional[str]:
    """Raison de rejet fondée sur le texte seul, ou None si plausible."""
    t = text.strip()
    if not t:
        return "empty"
    words = _WORD_RE.findall(t.lower())
    if not words:
        return "no-words"
    for p in CREDITS_PATTERNS:
        if p.search(t):
            return f"credits:{p.pattern}"
    for p in FAREWELL_PATTERNS:
        m = p.search(t)
        if m and len(t) < len(m.group(0)) + 12:
            return f"farewell:{p.pattern}"
    # « non non non non non » / « merci merci merci » : bégaiement de décodeur
    if len(words) >= 4:
        run = 1
        for a, b in zip(words, words[1:]):
            run = run + 1 if a == b else 1
            if run >= 4:
                return "stutter"
    return None


def stats_reason(
    st: SegmentStats,
    *,
    max_no_speech: float = 0.5,
    min_logprob: float = -1.0,
    max_compression: float = 2.4,
) -> Optional[str]:
    """Raison de rejet fondée sur les statistiques des segments, ou None."""
    if st.segments == 0:
        return None
    if st.no_speech > max_no_speech:
        return f"no-speech {st.no_speech:.2f} > {max_no_speech}"
    if st.logprob < min_logprob:
        return f"low-logprob {st.logprob:.2f} < {min_logprob}"
    if st.compression > max_compression:
        return f"repetitive {st.compression:.2f} > {max_compression}"
    return None


def hallucination_reason(
    text: str,
    segments: Iterable[object] = (),
    *,
    max_no_speech: float = 0.5,
    min_logprob: float = -1.0,
    max_compression: float = 2.4,
) -> tuple[Optional[str], SegmentStats]:
    """(raison ou None, statistiques) — None = texte à transmettre."""
    st = collect_stats(segments)
    reason = text_reason(text) or stats_reason(
        st,
        max_no_speech=max_no_speech,
        min_logprob=min_logprob,
        max_compression=max_compression,
    )
    return reason, st
