# Tri du courrier — pipeline et quarantaine

Yui trie les mails en quatre étages, avec apprentissage des règles de masse et quarantaine par expéditeur.

## Pipeline à quatre étages

Pour chaque mail entrant, les étages sont évalués dans l'ordre ; le premier qui conclut arrête :

1. **Règles confirmées** — verdict final appliqué immédiatement (label + archivage si la catégorie archive)
2. **Signaux de masse** — si aucune règle confirmée n'existe pour l'expéditeur, une règle `signal` est créée en quarantaine (label seulement, pas d'archivage)
3. **LLM** — pour l'inconnu, par lots de 12, plafonné à 24 mails par sondage ; au-delà, les mails restent non traités et passent au sondage suivant
4. **Repli** — LLM indisponible ou réponse inexploitable → catégorie `lire` sans archivage ; un mail relancé 3 fois en repli est accepté définitif

## Modèle de règles

Les règles vivent dans `data/config/mail-rules.json` (non versionné), registre `config` via `dataPath()`.

```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "r-8f3a",                       // stable, généré au premier apprentissage
      "when": {                              // ET entre les conditions présentes
        "from": "@linkedin.com",             // sous-chaîne, insensible à la casse, sur l'adresse ou le domaine
        "subject": "facture|invoice",        // regex insensible à la casse, optionnelle
        "header": "List-Unsubscribe"         // présence d'un en-tête, optionnelle
      },
      "then": { "category": "newsletter" },  // null = règle négative (bloque les signaux et renvoie au LLM à l'étage 3, n'attribue rien)
      "origin": "user" | "correction" | "signal",
      "confirmed": true,                     // false = quarantaine (en attente de validation)
      "hits": 12,                            // nombre d'appariements
      "lastHitAt": 1758990000000,            // ms, dernier appel
      "createdAt": 1758900000000             // ms, création
    }
  ]
}
```

**Ordre d'évaluation** : `user` → `correction` → `signal` ; à origine égale, la plus ancienne d'abord. Première correspondance gagne.

## Signaux de masse

Un mail déclenchant l'un de ces signaux (dans cet ordre) est proposé en quarantaine sous la catégorie correspondante :

| Signal | Catégorie | Critère |
|---|---|---|
| List-Unsubscribe | `newsletter` | En-tête présent |
| List-Id | `newsletter` | En-tête présent |
| Precedence: bulk/list | `notification` | En-tête présent |
| Auto-Submitted: auto-generated/auto-replied | `notification` | En-tête présent |
| Partie locale automatisée | `notification` | Adresse : `no-reply`, `noreply`, `donotreply`, `do-not-reply`, `notification`, `notifications`, `mailer-daemon`, `alert`, `alerts` |

Les signaux ne s'appliquent pas si : l'expéditeur a une règle confirmée (quelque qu'elle soit), ou une règle `perso` confirmée, ou une règle négative (`then.category: null`) qui le couvre.

## Quarantaine

Premier mail d'un expéditeur signalé : une règle `signal` est créée avec `confirmed: false`. Mails suivants : même règle, `hits++`, jamais envoyés au LLM. Rien n'expire.

**Actions** (via `POST /mail/quarantine/:ruleId/:action`) :

- **`confirm`** — `confirmed: true` ; archivage rétroactif des mails de l'expéditeur portant ce label (max 100)
- **`correct {category}`** — remplace la catégorie, change `origin` à `correction`, marque `confirmed: true` ; relabel et archivage rétroactif si la nouvelle catégorie archive
- **`reject`** — supprime la règle, crée une règle `user` négative (`then.category: null`) ; retire les labels de tous les mails en quarantaine de cet expéditeur ; l'expéditeur repasse par le LLM au prochain mail

## Urgence et routage

L'étage LLM classe chaque mail en `none | soon | now` :
- `none` (défaut) : aucune échéance
- `soon` : quelque chose attendu sous quelques jours (relance, document, échéance)
- `now` : à traiter aujourd'hui (urgent, ≤ 48 h, sécurité, réponse attendue)

Routes du routage (connecteur `mail`) :
- `category === 'action'` **OU** `urgency !== 'none'` → événement `mail-action-<mailId>` (`importance: 'utile'` si `none|soon`, `'urgent'` si `now`) ; création de post-it Yoji
- Autres catégories sans urgence → label seulement, pas d'événement (pile silencieuse)
- **Plafond** : 2 événements `urgent` par jour ; au-delà, `now` → `soon`

## Fichiers de state et config

| Fichier | Catégorie | Rôle |
|---|---|---|
| `data/config/mail-rules.json` | config | Toutes les règles (user, correction, signal) avec hits/confirmés |
| `data/state/mail-journal.json` | state | Anneau (200 max) des décisions de tri : qui a reçu quelle catégorie, à quel étage, avec urgence et raison |

Le fichier `proactive.json` conserve `concierge.rules` (legacy) lors de la migration initiale, puis l'ignore ; les règles lues au boot depuis `mail-rules.json`.

## Outils Gmail

### `list_messages_meta` (audience: `system`)

Récupère métadonnées (sans corps) pour un courrier sans télécharger le texte complet. Utilisé au scan par le concierge.

```json
{
  "query": "category:promotions",
  "maxResults": 50
}
```

Réponse : `[{id, threadId, from, to, subject, date, snippet, labelIds, headers}]`

En-têtes retournés : `From`, `To`, `Reply-To`, `Subject`, `Date`, `List-Unsubscribe`, `List-Id`, `Precedence`, `Auto-Submitted`, `X-Auto-Response-Suppress`.

## Routes API

| Route | Méthode | Rôle |
|---|---|---|
| `/mail/rules` | GET | Toutes les règles (sauf signaux non confirmés) |
| `/mail/rules` | POST | Créer ou remplacer ; validation : `when` non vide, regex valide, catégorie connue ou `null` |
| `/mail/rules/:id` | DELETE | Supprimer une règle (404 si inconnue) |
| `/mail/quarantine` | GET | Règles `signal` en quarantaine : `{ruleId, from, category, hits, lastHitAt}` |
| `/mail/quarantine/:id/confirm` | POST | Valider la quarantaine |
| `/mail/quarantine/:id/correct` | POST | Corriger la catégorie (corps : `{category}`) |
| `/mail/quarantine/:id/reject` | POST | Marquer comme bruit, créer règle négative |
| `/mail/reading` | GET | Pile « à lire » (≤ 50, label `Yui/A lire is:unread`) |
| `/mail/reading/:mailId/read` | POST | Marquer comme lu |
| `/mail/journal?limit=50` | GET | Décisions (défaut 50, max 200) |

Authentification Bearer sur toutes les routes.

## Migration des règles legacy

Au premier chargement, `concierge.rules` depuis `proactive.json` est migré vers `mail-rules.json` :
- Chaque `{match, category}` devient `{when: {from: match}, then: {category}, origin: 'correction', confirmed: true}`
- Fichier `mail-rules.json` créé une fois ; `concierge.rules` est ensuite ignoré

Effectué dans `migrateMailRulesIfNeeded()`, appelé au boot du concierge — idempotent.
