# `POST /notify` — notifier le téléphone depuis un autre dépôt

Point d'entrée pour qu'une app (Koya, Genkin, Astronix, Aster…) fasse remonter une alerte
sur le téléphone via Yui, sans passer par le LLM : le texte envoyé est le texte affiché.

- **URL** : `http://<hôte Yui>:<port orchestrateur>/notify` (prod : `http://10.0.0.101:10001/notify`)
- **Auth** : `Authorization: Bearer <BEARER_TOKEN>` — la valeur de `BEARER_TOKEN` dans le `.env` de Yui.
- **Corps** (JSON) :

| Champ | Type | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `text` | string ≤ 500 | oui | Texte de la notification (alias acceptés : `message`, `body`) |
| `title` | string ≤ 80 | non | Titre affiché. Défaut : `source`, sinon « Yui » |
| `source` | string ≤ 40 | non | Nom de l'app émettrice — apparaît dans le journal d'activité (`/activity`) |
| `speak` | boolean | non | `true` = lu à voix haute sur l'enceinte en plus du push (si le pipeline voix tourne) |

- **Réponse** : `{ ok: true, pushed: boolean, spoken: boolean }` — `pushed: false` signifie que le
  push n'a pas pu partir (pas de token FCM enregistré / pas de compte de service Firebase), l'appel
  reste 200 : la notification est journalisée quoi qu'il arrive.
- **Erreurs** : `400 { error }` (texte manquant ou trop long), `401` (Bearer absent ou faux).

## Exemples

```bash
curl -X POST http://10.0.0.101:10001/notify \
  -H "Authorization: Bearer $YUI_BEARER" -H "Content-Type: application/json" \
  -d '{"source":"Koya","text":"PM2 : yui-voice est tombé sur homelab-01"}'

# Lu à voix haute aussi
curl -X POST http://10.0.0.101:10001/notify \
  -H "Authorization: Bearer $YUI_BEARER" -H "Content-Type: application/json" \
  -d '{"source":"Aster","title":"CVE critique","text":"CVE-2026-1234 touche nginx sur bastion","speak":true}'
```

Depuis un backend Node :

```ts
await fetch(`${process.env.YUI_URL}/notify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.YUI_BEARER}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'Koya', text: 'Disque plein sur nas (94 %)' }),
});
```

## Bonnes pratiques

- Un appel = une information utile pour un humain. Pas de flood : dédupliquez côté émetteur
  (une alerte qui persiste ne se renvoie pas toutes les minutes).
- Texte court, sujet en tête (« PM2 : … », « Disque : … ») — il est lu tel quel, y compris par le TTS.
- `speak` uniquement pour ce qui mérite d'interrompre (panne, sécurité) ; le push suffit sinon.
- Ce point d'entrée est volontairement « bête ». Le tri, le regroupement et le bon moment pour
  parler relèvent du futur bus d'événements (`POST /events`, voir la note Yoji
  « Secrétaire — conception ») : `/notify` restera le canal direct « affiche ça, maintenant ».
