# Yui — Backlog

Workflow : 1 feature = 1 branche git (`feat/xxx`).
Demander à Claude Code de switcher sur la bonne branche avant de commencer.

---

## 🔴 Bloquant / En cours

### Porcupine wakeword — nécessite actions manuelles
**Branche :** `main` (migration faite, en attente config)
- [ ] `pip install pvporcupine --break-system-packages`
- [ ] Créer compte + récupérer AccessKey sur console.picovoice.ai
- [ ] Entraîner "Hey Yui" (French) → télécharger `.ppn` Linux x86_64
- [ ] Placer à `assets/wakeword/yui.ppn`
- [ ] Renseigner `PORCUPINE_ACCESS_KEY` dans `ecosystem.config.js`
- [ ] Mettre `TRIGGER_WORD: 'Hey Yui'` dans `ecosystem.config.js`
- [ ] `pm2 reload yui-voice --update-env`

---

## 🟡 Prêt à développer

### Output channel des schedules
**Branche :** `feat/schedule-output-channel`
Permettre de configurer le canal de sortie (`cast`/`notify`/`none`) par schedule,
sans que le LLM le choisisse. Options :
- Champ `output` dans `data/schedules.json` (admin-only, édité à la main)
- L'orchestrateur déduit le canal selon le contexte d'entrée (HTTP vs vocal)

### Volume TV (optimisation)
**Branche :** `feat/tv-volume`
`setVolume()` envoie 50 KEY_VOLDOWN + N KEY_VOLUP (~7s). Trouver une API
plus directe (REST Samsung ou valeur absolue via WS si disponible).

### Vérification cast wallpaper end-to-end
**Branche :** `feat/cast-media` (ou sur main si rapide)
Infrastructure ffmpeg loop en place, à valider après reboot Chromecast :
- `cast_wallpaper` depuis le dashboard
- Vérifier que l'image reste affichée indéfiniment

---

## 🟢 Idées / Plus tard

### YuiApp (mobile)
**Branche :** `feat/yui-app`
Dossier `YuiApp/` présent. App mobile pour contrôle à distance, notifications,
et potentiellement GPS presence.

### Ringtones pour timers
Ajouter des fichiers `.mp3`/`.wav` dans `assets/ringtones/`.
Timer MCP prêt à les servir via `/ringtones`.

### AEC (Acoustic Echo Cancellation) ReSpeaker
Le XVF3800 a de l'AEC matériel mais nécessite un signal de référence.
Brancher la sortie audio sur le canal de référence pour éviter que
le micro capte la musique/TTS.

### Somfy (volets)
**Branche :** `feat/mcp-somfy` (package déjà présent)
Package `packages/mcp-somfy/` présent mais non intégré/testé.
À connecter à l'orchestrateur.

---

## ✅ Fait (non commité — à commiter)

- Migration wakeword OWW → Porcupine (pipeline + wakeword.py)
- Samsung TV WebSocket port 8002 + token pairing + PowerState check
- Cast media (wallpaper/video) dans mcp-chromecast comme hidden tools
- Serveur ffmpeg loop `/media/loop/:subdir/:file` dans HttpSource
- Timer MCP avec ringtones (renommé depuis sonnerie)
- Presence manager (GPS + MAC departure)
- Scheduler output channels (cast/notify/none)
- mcp-somfy package initial
- Pipeline wakeword_pending (Silero confirm après OWW trigger)
- Chimes pour acknowledgment Yui
- Moteur de proactivité (watchers météo/présence/agenda/mail + digest + garde anti-conflit)
