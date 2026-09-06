"""État partagé de la parole de Yui.

Une seule vérité, quelle que soit la source de la voix : réponse à un ordre
(`server._post_order`), annonce du scheduler/proactivité (`tts.speak` via
POST /speak). Le pipeline micro lit `speaking` pour passer en mode barge-in
(écoute pendant la lecture, purge du tampon en fin de parole) ; poser `stop`
interrompt la lecture en cours, d'où qu'elle vienne.
"""
import threading

# Yui parle (réponse en cours de lecture, ou annonce du scheduler).
speaking = threading.Event()

# Demande d'interruption de la lecture en cours (barge-in, « stop »).
stop = threading.Event()
