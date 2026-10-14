import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

from stt_filter import collect_stats, hallucination_reason, stats_reason, text_reason


def seg(start, end, ns=0.05, lp=-0.3, cr=1.4, t=0.0):
    return SimpleNamespace(start=start, end=end, no_speech_prob=ns, avg_logprob=lp,
                           compression_ratio=cr, temperature=t)


def test_credits_reject_whole_utterance():
    for text in [
        "Sous-titrage ST' 501",
        "Allô ? Allô ? – Sous-titrage FR 2021",
        "Sous-titres réalisés par la communauté d'Amara.org",
        "Merci d'avoir regardé cette vidéo",
        "Abonnez-vous à la chaîne",
        "Sous titrage Société Radio-Canada",
    ]:
        assert text_reason(text) is not None, text


def test_real_orders_pass():
    for text in [
        "Allume le salon",
        "Hello, qu'est-ce que j'ai dans mes tâches ?",
        "Dis à Marie à bientôt et éteins tout",
        "Mets un minuteur de dix minutes, merci",
        "C'est à quelle heure mon cours de maths cet après-midi ?",
        "non non c'est bon",
    ]:
        assert text_reason(text) is None, text


def test_farewell_only_when_alone():
    assert text_reason("À bientôt !") is not None
    assert text_reason("Merci.") is not None
    assert text_reason("Merci de votre attention.") is not None
    assert text_reason("Merci, tu peux éteindre la cuisine") is None


def test_empty_and_stutter():
    assert text_reason("   ") == "empty"
    assert text_reason("...") == "no-words"
    assert text_reason("non non non non non") == "stutter"


def test_stats_weighted_by_duration():
    st = collect_stats([seg(0, 1, ns=0.9), seg(1, 4, ns=0.1)])
    assert abs(st.no_speech - 0.3) < 1e-6
    assert st.segments == 2 and abs(st.duration - 4) < 1e-6


def test_stats_thresholds():
    assert stats_reason(collect_stats([seg(0, 2)])) is None
    assert stats_reason(collect_stats([seg(0, 2, ns=0.8)])).startswith("no-speech")
    assert stats_reason(collect_stats([seg(0, 2, lp=-1.4)])).startswith("low-logprob")
    assert stats_reason(collect_stats([seg(0, 2, cr=3.1)])).startswith("repetitive")
    assert stats_reason(collect_stats([])) is None


def test_hallucination_reason_combines():
    reason, st = hallucination_reason("Allume le salon", [seg(0, 1.5)])
    assert reason is None and "seg=1" in st.summary()
    reason, _ = hallucination_reason("Allume le salon", [seg(0, 1.5, ns=0.7)])
    assert reason and reason.startswith("no-speech")
    reason, _ = hallucination_reason("Sous-titrage ST' 501", [seg(0, 1.5)])
    assert reason and reason.startswith("credits")
