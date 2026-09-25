# `POST /events` — pousser des événements dans le bus de Yui

Différence avec `/notify` : `/notify` = « affiche ça, maintenant » (aucun filtre, aucun LLM).
`/events` = « voilà ce qui s'est passé, à toi de voir » : péremption, dédup, cooldown par
source, heures de silence, puis le juge décide de parler, notifier, retenir pour le prochain
point, ou se taire.

- **URL** : `http://<hôte Yui>:<port>/events` (prod : `http://10.0.0.101:10001/events`)
- **Auth** : `Authorization: Bearer <BEARER_TOKEN>` (`.env` de Yui)
- **Corps** : un événement ou un tableau (≤ 50), ≤ 32 Ko.

| Champ | Type | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `source` | string ≤ 40 | oui | Nom de l'app (`koya`, `genkin`…). Crée une brique `external:<source>`, activable/désactivable sur /proactive |
| `key` | string ≤ 120 | oui | Idempotence : même `source`+`key` = même événement (dédup, sauf si `facts` changent) |
| `kind` | `alert` \| `info` \| `request` \| `digest` | oui | Nature : ça ne va pas / ça s'est passé / une action est attendue / matière à point |
| `importance` | `info` \| `utile` \| `urgent` \| `critique` | oui | `urgent` ignore heures de silence et cooldown (dans la limite de 3 × `maxPerHour`) ; `critique` court-circuite tout (réservé aux vraies urgences) |
| `subject` | string ≤ 200 | oui | Une ligne, lue telle quelle par le TTS |
| `facts` | string[] ≤ 10 | non | Détails factuels pour le juge — jamais inventés |
| `at` | epoch ms | non | Horodatage source (défaut : réception) |
| `ttlMs` | number | non | Périmé après `at + ttlMs` (une alerte résolue ne sert plus) |
| `link` | URL http(s) | non | Lien profond |
| `action` | `{ id, tag }` | non | Action whitelistée de proactive.json |

- **Réponse** : `202 { accepted, held, deduplicated, expired, ignored }` — `ignored` = source coupée sur /proactive.
- **Erreurs** :
  - `400 { errors: [{ index, message }] }` (tout ou rien : rien n'est accepté si un élément est invalide)
  - `401` (Bearer absent ou faux)
  - `413` (corps trop gros, > 32 Ko)
  - `500` (ingestion échouée — erreur serveur)
  - `503` (proactivité non disponible)

## Exemples

```bash
curl -X POST http://10.0.0.101:10001/events \
  -H "Authorization: Bearer $YUI_BEARER" -H "Content-Type: application/json" \
  -d '{"source":"koya","key":"disk-nas","kind":"alert","importance":"utile",
       "subject":"Disque nas à 94 %","facts":["/srv/media 1,8 To / 1,9 To"],
       "ttlMs":86400000,"link":"https://koya.home.arpa/hosts/2"}'
```

Depuis un backend Node :

```ts
await fetch(`${process.env.YUI_URL}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.YUI_BEARER}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
        source: 'koya', // jamais replié en minuscules côté Yui : une casse ≠ une autre source
        key: 'disk-nas',
        kind: 'alert',
        importance: 'utile',
        subject: 'Disque nas à 94 %',
        facts: ['/srv/media 1,8 To / 1,9 To'],
        ttlMs: 86400000
    }),
});
```

## Bonnes pratiques

- `key` stable par situation (`disk-nas`, `pm2-yui-voice`) : renvoyer la même clé quand ça persiste ;
  changer les `facts` quand ça évolue (94 % → 98 %) — c'est ce qui repasse la dédup.
- `ttlMs` sur tout ce qui a une durée de validité.
- `urgent` avec parcimonie ; `critique` jamais depuis un script automatique.
- Au-delà de `maxPerHour` (6 par défaut ; par source dans `data/config/proactive.json` →
  `bricks["external:<source>"].settings.maxPerHour`, le toggle de la source étant sur /proactive) les
  événements sont retenus sans LLM et ressortent au prochain point. Un `urgent` ignore ce plafond
  jusqu'à 3 × `maxPerHour`, au-delà il est retenu comme le reste ; seul `critique` n'est jamais plafonné.
