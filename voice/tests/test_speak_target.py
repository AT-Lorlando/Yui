"""Test de speak_target (enceinte cible de /speak)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from speak_target import speak_target


def test_speak_target():
    assert speak_target({"text": "x"}, "Salon") is None
    assert speak_target({"device": "Chambre"}, "Salon") == "Chambre"
    assert speak_target({"device": "salon"}, "Salon") is None
    assert speak_target({"device": "  "}, "Salon") is None
    assert speak_target({"device": 3}, "Salon") is None
