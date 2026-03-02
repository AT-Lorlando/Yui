#!/usr/bin/env python3
"""
XTTS v2 TTS server
==================
Runs in a Python 3.11 venv (Coqui TTS requirement).
Exposes a simple HTTP API for voice_pipeline.py:

  POST /tts
    body: {
      "text":        "...",
      "language":    "fr",
      "speaker":     "Lilya Stainthorpe",   # built-in speaker
      "speaker_wav": "/path/to/ref.wav",    # voice clone (overrides speaker)
      "speed":       1.2                    # playback speed multiplier (default 1.0)
    }
    → audio/wav

  GET  /speakers   → JSON list of built-in speaker names
  GET  /health     → 200 OK

Run with:
  /home/chuya/.venvs/xtts/bin/python src/xtts_server.py
"""

import io, json, os, warnings
warnings.filterwarnings("ignore")

PORT     = int(os.getenv("XTTS_PORT", "18770"))
LANGUAGE = os.getenv("XTTS_LANG", "fr")
DEVICE   = os.getenv("XTTS_DEVICE", "cuda")

print("Loading XTTS v2 model…", flush=True)

import torch
# PyTorch 2.6 changed weights_only default to True, breaking TTS model loading
_orig_load = torch.load
torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, "weights_only": False})

# torchaudio 2.6+ removed set_audio_backend; patch .load() to use soundfile directly
import torchaudio, soundfile as _sf, numpy as _np
def _ta_load(filepath, *args, **kwargs):
    data, sr = _sf.read(str(filepath), dtype="float32", always_2d=True)
    return torch.from_numpy(data.T), sr  # (channels, samples), sample_rate
torchaudio.load = _ta_load

os.environ["COQUI_TOS_AGREED"] = "1"
from TTS.api import TTS
import soundfile as sf
import numpy as np
import librosa

tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(DEVICE)
speakers = list(tts.synthesizer.tts_model.speaker_manager.name_to_id)
DEFAULT_SPEAKER = os.getenv("XTTS_SPEAKER", "Lilya Stainthorpe")
DEFAULT_SPEED   = float(os.getenv("XTTS_SPEED", "1.15"))

print(f"XTTS v2 ready — {len(speakers)} speakers", flush=True)
print(f"Default: speaker='{DEFAULT_SPEAKER}'  speed={DEFAULT_SPEED}", flush=True)
print(f"Listening on :{PORT}", flush=True)


def generate(text: str, language: str, speaker: str | None,
             speaker_wav: str | None, speed: float) -> bytes:
    if speaker_wav:
        wav = tts.tts(text=text, language=language, speaker_wav=speaker_wav)
    else:
        wav = tts.tts(text=text, language=language, speaker=speaker or DEFAULT_SPEAKER)

    audio = np.array(wav, dtype=np.float32)

    if speed != 1.0:
        audio = librosa.effects.time_stretch(audio, rate=speed)

    buf = io.BytesIO()
    sf.write(buf, audio, 24000, format="WAV")
    return buf.getvalue()


from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/tts":
            self.send_error(404); return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        text        = body.get("text", "")
        language    = body.get("language", LANGUAGE)
        speaker     = body.get("speaker", DEFAULT_SPEAKER)
        speaker_wav = body.get("speaker_wav")
        speed       = float(body.get("speed", DEFAULT_SPEED))
        try:
            audio = generate(text, language, speaker, speaker_wav, speed)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_error(500, str(e))

    def do_GET(self):
        if self.path == "/speakers":
            body = json.dumps(speakers).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        elif self.path == "/health":
            self.send_response(200); self.end_headers()
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        print(f"[XTTS] {fmt % args}", flush=True)


HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
