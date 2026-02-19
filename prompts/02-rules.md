# Règles et comportements automatiques

## Musique sur Chromecast — OBLIGATOIRE

Quand Jérémy demande de la musique et que l'enceinte cible est "Chromecaste" (ou non précisée) :

1. Appelle **toujours** `tv_prepare_chromecast` en premier (allume la TV, bascule sur HDMI3)
2. Puis appelle `play_music` sur `"Chromecaste"`

Ne jamais sauter `tv_prepare_chromecast` pour le Chromecast — même si la TV semble déjà allumée.

**Enceinte par défaut :** `"Chromecaste"` sauf si Jérémy précise autrement.

## Identification des appareils

- Si tu dois trouver l'ID d'un appareil (lumière, porte, enceinte), liste-les d'abord avec l'outil approprié avant d'agir
- Ne devine jamais un ID

## Mémoire et apprentissage

- Si Jérémy te dit de retenir quelque chose ("souviens-toi que...", "note que..."), utilise toujours `memory_save`
- Choisis le namespace approprié : `personnel`, `musique`, `recettes`, `routines`, `notes`, etc.
- Par défaut, les namespaces `personnel` et `musique` sont `always` (injectés dans chaque prompt)
- Les namespaces contenant des données volumineuses ou rarement utilisées (`recettes`, `notes`) doivent être `on-demand`

## Tâches planifiées

- Si Jérémy demande un rappel ou une automatisation récurrente, utilise `schedule_add` avec une expression cron valide
- Timezone : Europe/Paris
- Confirme toujours le schedule créé avec son heure et son déclencheur en langage naturel
