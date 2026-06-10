# Wake word — OpenWakeWord

Détection du mot déclencheur avec un modèle ONNX personnalisé entraîné sur ta voix.

L'inférence tourne **sur le serveur** (`voice/wake.py`, process `yui-voice`), pas
sur le Pi (le Pi n'est qu'un micro UDP). `WAKEWORD_NAME` ne pilote que
l'**entraînement** (dossiers d'échantillons + nom du `.onnx` produit). En prod on
pointe vers un fichier modèle via `WAKEWORD_MODEL` ; le seuil `WAKEWORD_THRESHOLD`
est surchargé en live par `data/voice-tuning.json` (page `/debug`) — voir le bloc
env `yui-voice` dans `ecosystem.config.js`.

---

## Changer de wake word

Dans `.env` :

```env
WAKEWORD_NAME=yui        # nom du wake word (minuscules)
```

Puis ré-enregistrer et ré-entraîner :

```bash
python scripts/record_wakeword.py   # échantillons → assets/wakeword/samples/yui/
python scripts/train_wakeword.py    # modèle      → assets/wakeword/yui.onnx
pm2 restart yui-voice   # OWW tourne maintenant sur le serveur
```

Chaque wake word a ses propres dossiers d'échantillons et son propre `.onnx` — rien n'est écrasé quand tu changes.

---

## Architecture

```
Pi: ffmpeg hw:1,0 → UDP :5002 (16kHz mono s16le)
    │
    ▼ voice/audio_source.py — ring buffer, chunks 1280 samples (80ms)
voice/wake.py — openwakeword.Model (melspec+embedding backbones figés)
    │
    ▼ (1, 16, 96) embeddings → {name}.onnx [MLP entraîné sur ta voix]
    score 0–1
    │
    ▼ score > WAKEWORD_THRESHOLD
voice/server.py — capture VAD (voice/vad_capture.py) → Whisper → orchestrateur
```

MLP PyTorch :

```
Flatten  →  Linear(1536, 128)  →  ReLU  →  Dropout(0.3)
         →  Linear(128, 32)   →  ReLU
         →  Linear(32, 1)     →  Sigmoid
```

---

## Dépendances

```bash
# Entraînement (machine de dev) :
pip install openwakeword==0.4.0 torch onnx onnxruntime sounddevice
# Inférence (Raspberry Pi) — pas de torch :
pip install openwakeword==0.4.0 onnxruntime numpy
```

> `openwakeword >= 0.5` nécessite `tflite-runtime` sans wheel Python 3.12. Rester sur 0.4.0.

---

## Entraînement

### 1 — Enregistrer

```bash
python scripts/record_wakeword.py
```

Objectif : **50 positifs + 50 négatifs**.

**Positifs** — dis le wake word en 2 secondes. Varie :
- Distance au micro (30 cm, 1 m, 2 m, depuis la pièce d'à côté)
- Ton (normal, fatigué, enthousiaste, chuchoté)
- Vitesse (normal, rapide, lent)
- Quelques clips avec bruit de fond (TV, musique)

**Négatifs** — tout sauf le wake word. Priorité aux mots phonétiquement proches :

| Wake word | Mots pièges à enregistrer en négatifs |
|-----------|---------------------------------------|
| `yui`     | "oui", "lui", "nuit", "bruit", "fruit", "je suis", "la pluie", "gratuit", "Louis" |
| `lunix`   | "Linux", "Louis", "Lucie", "lumineux", "lundi", "luna" |

Puis compléter avec de la parole normale (lire un texte 2s à la fois), du silence, des bruits de fond.

### 2 — Entraîner

```bash
python scripts/train_wakeword.py
```

Ce que fait le script :
- Augmente chaque clip ×8 (speed ±15%, volume ±20%, bruit gaussien)
  → simule les conditions réelles sans les enregistrer toutes
- Calcule les embeddings via OWW `AudioFeatures.embed_clips()` → `(N, 16, 96)`
- Entraîne le MLP PyTorch (60 époques, ~2 min sur CPU)
- Exporte `assets/wakeword/{name}.onnx`
- Vérifie avec onnxruntime

### 3 — Activer

```bash
pm2 restart yui-voice   # OWW tourne maintenant sur le serveur
```

---

## Réglage de la sensibilité

```env
WAKEWORD_THRESHOLD=0.5   # 0.0–1.0 (défaut 0.5)
```

- **< 0.5** → plus sensible (plus de faux positifs)
- **> 0.5** → plus strict (peut rater des déclenchements)

Le pipeline loggue le score à chaque détection pour faciliter le réglage.

---

## Structure des fichiers

```
assets/wakeword/
├── README.md
├── yui.onnx                          ← modèle actif (généré par train_wakeword.py)
└── samples/
    └── yui/                          ← un dossier par wake word
        ├── positive/  yui_001.wav …
        └── negative/  neg_001.wav …

voice/wake.py                         ← chargement ONNX + inférence OWW (sur le serveur)
voice/server.py                       ← pipeline (UDP → OWW → VAD → Whisper)
ecosystem.config.js (yui-voice)       ← env WAKEWORD_MODEL / WAKEWORD_THRESHOLD

scripts/record_wakeword.py            ← enregistrement interactif
scripts/train_wakeword.py             ← entraînement + export ONNX
```

---

## Ré-entraîner avec de nouveaux clips

Les scripts continuent la numérotation existante — les anciens clips ne sont pas supprimés.

```bash
python scripts/record_wakeword.py   # ajoute des clips aux dossiers existants
python scripts/train_wakeword.py    # ré-entraîne sur TOUS les clips
pm2 restart yui-voice   # OWW tourne maintenant sur le serveur
```
