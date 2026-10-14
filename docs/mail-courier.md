# Courrier v3 — listes d'expéditeurs, lecteur IA, ordres

Yui range le courrier par **expéditeur** (trois listes) et confie la lecture à un **lecteur IA** qui ne répond qu'à une question : *faut-il prévenir Jérémy ?* Plus de catégories, plus de quarantaine, plus de règles par signal : le tri en quatre étages du 28/09 a disparu.

Code : `orchestrator/src/orchestrator/proactive/mail/` — `senders.ts` (listes, résolution), `courier.ts` (le facteur : poll, rangement, lecture, balayage), `reader.ts` (prompt et parse du lecteur), `bodyClean.ts`, `orders.ts`, `migrate.ts` + `bootMigration.ts`, `journal.ts`, `signals.ts`. Le connecteur `mail` (`proactive/connectors/mail.ts`) fait tourner le facteur à chaque poll.

## Les trois listes

| Expéditeur | Rangement Gmail | Lecture IA |
|---|---|---|
| **À garder** | label `Boîtes/<Nom>` (créé à la volée), retiré de la boîte de réception | selon `read` : `always`, `never`, ou `rules` |
| **Osef** | label `Yui/Spam`, archivé ; corbeille après 15 jours (voir *Balayage*) | jamais |
| **Inconnu** (aucune entrée) | reste en boîte de réception, intact | toujours |

```jsonc
// data/config/mail-senders.json (non versionné)
{
  "version": 3,
  "keep": [
    {
      "id": "k-8f3a2c",
      "match": "boursorama.com",          // sous-chaîne, insensible à la casse, sur l'adresse ou le from brut
      "name": "Boursorama",               // → label Boîtes/Boursorama
      "read": "rules",                    // always | never | rules
      "rules": [                          // read = rules seulement ; regex de sujet, première qui matche gagne (≤ 20)
        { "subject": "contact|message", "read": true },
        { "subject": "rapport", "read": false }
      ],
      "readDefault": false,               // aucune règle ne matche
      "hits": 12, "lastHitAt": 0, "createdAt": 0
    }
  ],
  "spam": [{ "id": "s-…", "match": "promo.example.fr", "hits": 3, "createdAt": 0 }]
}
```

**Résolution** (`resolveSender`, pure et testée) :

1. Parmi les « à garder » qui matchent, le `match` **le plus long** gagne (une adresse exacte l'emporte sur son domaine).
2. Un « à garder » l'emporte toujours sur un « osef ».
3. Sinon, le premier « osef » qui matche.
4. Sinon : inconnu → boîte de réception + lecteur.

Une regex de sujet invalide est ignorée (un seul avertissement par expéditeur), jamais de plantage du tri.

**Inconnus** : chaque expéditeur inconnu entre dans la file « Nouveaux expéditeurs » de l'app (adresse, nombre, dernier sujet ; 200 max, état dans `mail-courier.json`). Un geste « Garder » (nom + lecture) ou « Osef » le sort de la file. Les signaux de masse (`List-Unsubscribe`, `List-Id`, `Precedence: bulk|list`, `Auto-Submitted`, partie locale `no-reply`/`alerts`…, `detectSignal` dans `signals.ts`) **ne décident rien** : ils pré-cochent « Osef » dans cette file. Un inconnu non traité revient à chaque mail — jamais de spam implicite.

**Rangement rétroactif** (`POST /mail/senders/:id/apply`) : les mails des 90 derniers jours de l'expéditeur (≤ 100 par défaut, 200 max) reçoivent son label et sont archivés ; un « à garder » retire au passage `Yui/Spam`. Jamais de corbeille rétroactive.

## Le lecteur IA

Lit les mails des **inconnus** et des « à garder » dont la lecture est active. Un appel LLM par lot de **12**, **24 mails max par poll** (le reste attend le poll suivant).

**Corps nettoyé** (`cleanBody`, ≤ 2 500 caractères) : citations (`>`, « Le … a écrit : », « On … wrote: », « Original Message », bloc `De:/Envoyé:`), signature (`-- `), pied de page (se désabonner, mentions légales, « vous recevez ce mail »…) coupés ; liens → `[lien]` ; espaces compactés.

**Prompt système** = ordre général + ordres actifs + contrat JSON :

- **Ordre général** : `prompts/mail-reader.md` s'il existe et n'est pas vide, sinon `DEFAULT_READER_PROMPT` (`reader.ts`). Le dossier `prompts/` est hors git : le fichier se pose à la main en prod (voir *Prompt par défaut*).
- **Ordres en cours** : une ligne par ordre actif, `- [o-3] texte (jusqu'au 28/10)`.

**Contrat de sortie** — un objet par mail, dans l'ordre :

```json
[{ "i": 1, "notify": true, "urgency": "now", "reason": "Michel répond à ta demande de devis",
   "orderId": "o-3", "fulfilled": true, "facts": ["Devis : 1 240 €", "Réponse attendue avant vendredi"] }]
```

`parseReaderReply` (pur, testé) : `notify` faux par défaut, `urgency` `none` par défaut, `reason` ≤ 160 caractères, 5 faits max de 120 caractères, `orderId` inconnu jeté (et `fulfilled` avec lui). Un mail sans réponse exploitable est relu au poll suivant ; après **3 échecs** il est conclu tel quel (reste en boîte de réception non lu).

**Ce que devient la réponse** :

- `notify: true` → **sortie immédiate** (`notifyMail` → `pushNow`) : notification, parole si Jérémy est présent et hors heures de silence. Plafond **`MAIL_NOTIFY_PER_DAY` = 5** par jour (relu du journal au redémarrage) ; au-delà, rien n'est poussé, une seule entrée `hold` « Notification plafonnée » est écrite au journal proactif pour la journée, et les mails suivants sont seulement comptés. Dans tous les cas le connecteur émet ensuite un événement `utile` `mail-notify-<id>` (raison + faits, fait « Notification plafonnée pour aujourd'hui » si plafonné) avec un post-it Yoji « Répondre : … ».
- `notify: false` avec des `facts` → événement `info` `mail-info-<id>` retenu (`held-events`) pour le **prochain point** de la secrétaire.
- `fulfilled: true` sur un ordre → ordre passé `fulfilled`, événement `info` « **Ordre satisfait** : <texte de l'ordre> » pour le prochain point, même sans alerte ni faits.

> Avec la brique `judge` coupée, l'ancien pipeline (chattiness + phrase) peut pousser une seconde fois un mail déjà notifié (l'événement `utile` y passe comme un autre).

## Ordres de lecture

`data/config/mail-orders.json` (non versionné) — `{id, text ≤ 300, createdAt, expiresAt, source: user|voice|connector, origin?, state: active|fulfilled|expired, fulfilledAt?, fulfilledBy?, result?}`, 40 ordres max.

- **Général** : le prompt `prompts/mail-reader.md` (ce qui est urgent chez Jérémy, ce qui ne l'est jamais).
- **Temporaires** : posés depuis l'app (carte « Ce que j'attends » de `/mail`, `POST /mail/orders`) ou à la voix par le tool `mail_watch`. Durée par défaut 14 jours (1–60). Un ordre échu passe `expired`.
- **Automatiques** : posés par un connecteur avec un `origin`. Premier cas, les colis (`connectors/deliveries.ts`) : un colis `shipped`/`in_transit`/`out_for_delivery` pose « Commande <contenu> : extraire la date de livraison estimée, le transporteur et le numéro de suivi » (21 jours, `origin: parcel:<id>`, libellé rogné pour tenir dans 300 caractères), une seule fois par colis ; la livraison le referme.

### Tool `mail_watch`

Tool LLM `mail_watch {text (5–300), days? (1–60, défaut 14)}` — « Yui, préviens-moi quand Michel répond ». Crée un ordre `source: voice` via le moteur proactif (`setMailWatchProvider` dans `main.ts`).

## Balayage osef

Une fois par jour (dans le poll du connecteur `mail`) : `label:"Yui/Spam" older_than:15d` → `trash_email` par lot de 50, journal `stage: trash`. **Corbeille seulement**, jamais de suppression définitive : Gmail purge la corbeille 30 jours plus tard, soit 45 jours récupérables au total.

## Fichiers

| Fichier | Catégorie | Rôle |
|---|---|---|
| `mail-senders.json` | `config` | Les listes « à garder » / « osef » (éditable, `PUT /mail/senders`) |
| `mail-orders.json` | `config` | Ordres de lecture |
| `mail-courier.json` | `state` | État du facteur : `processedIds`, essais de lecture, file des inconnus, mails en attente de lecture, dernier balayage, compteurs |
| `mail-migration.json` | `state` | Rapport de la migration v2 → v3 (bandeau unique sur `/mail`) |
| `mail-journal.json` | `state` | Anneau des 200 dernières décisions : étage `keep` / `spam` / `inbox` / `trash` (les anciennes entrées gardent `rule` / `signal` / `llm` / `fallback`), `box`, `read`, `notify`, `urgency`, `reason`, `orderId` |
| `mail-rules.v2.bak.json` | `config` | Anciennes règles v2, renommées après migration (sauvegarde, plus lues) |

Tous les chemins passent par `dataPath()`.

## Migration v2 → v3

Une fois, au démarrage du moteur (`migrateMailRulesAtBoot`), si `mail-senders.json` n'existe pas encore et que `mail-rules.json` existe. Lecture tolérante (`readRulesFile` : fichier illisible → aucune règle), conversion pure (`migrateRulesToSenders`) :

- catégories `promo`, `newsletter`, `osef`, `notification` → **osef** ;
- `finance`, `securite`, `admin`, `commande`, `evenement`, `action`, `lire`, `perso` → **à garder**, `name` = label de deuxième niveau du domaine avec majuscule (`qonto.com` → Qonto, `notif.laposte.fr` → Laposte ; une adresse sur un domaine grand public prend sa partie locale), noms dédoublonnés ; `read: always` pour `action`/`securite`/`lire`/`perso`, `never` sinon ;
- une règle `{from, subject}` devient une règle de contenu de l'expéditeur (`read: rules`, `readDefault` = ancien mode) ;
- « pas du bruit » (`category: null`) et règles sans expéditeur → **supprimées** (l'expéditeur redevient inconnu) ;
- signaux en quarantaine (non confirmés) → rapport `unknown`, pré-cochés osef dans la file.

Puis `mail-senders.json` est écrit, le rapport posé dans `mail-migration.json`, et `mail-rules.json` renommé **`mail-rules.v2.bak.json`**. Un échec laisse `mail-rules.json` en place (nouvel essai au démarrage suivant). La section `concierge` de `proactive.json` est ignorée si elle traîne encore.

## Routes API

Authentification Bearer sur toutes les routes (`input/routes/mail.ts`).

| Route | Méthode | Rôle |
|---|---|---|
| `/mail/senders` | GET | Fichier des listes complet |
| `/mail/senders` | PUT | Remplace tout le fichier, validé tout-ou-rien (400 sinon) |
| `/mail/senders/keep` | POST | `{match, name, read?, rules?, readDefault?}` → crée ou remplace un « à garder » (201) |
| `/mail/senders/spam` | POST | `{match}` → met un expéditeur en osef (201) |
| `/mail/senders/:id` | DELETE | Retire un expéditeur (204, 404 si inconnu) |
| `/mail/senders/:id/apply` | POST | `{max? ≤ 200, défaut 100}` → rangement rétroactif `{matched, applied}` |
| `/mail/unknown` | GET | File des nouveaux expéditeurs (signal de masse → pré-coché osef) |
| `/mail/orders` | GET | Ordres (actifs, satisfaits, expirés) |
| `/mail/orders` | POST | `{text, days? 1–60}` → nouvel ordre (201, 400 si trop long ou plafond atteint) |
| `/mail/orders/:id` | DELETE | Supprime un ordre (204 / 404) |
| `/mail/dry-run` | POST | `{query?, max? ≤ 100}` → verdict des listes par mail, **aucune écriture** |
| `/mail/scan` | POST | Lance un poll du facteur maintenant |
| `/mail/journal?limit=50&scope=actions` | GET | Décisions (défaut 50, max 200) |
| `/mail/stats?days=7` | GET | Compteurs du journal par étage (1–90 jours) |
| `/mail/migration` | GET | Rapport de migration, 404 s'il n'y en a pas |

Le dashboard (`DashboardData.briefing`) porte `pendingCount` = nouveaux expéditeurs, `ordersCount` = ordres actifs, `doubtCount` = 0 (compatibilité) ; la tuile s'affiche dès qu'il y a l'un des deux ou un mail signalé.

## Prompt par défaut

`prompts/mail-reader.md` remplace `DEFAULT_READER_PROMPT` dès qu'il existe et n'est pas vide (relu à chaque lot, pas de redémarrage). Point de départ à copier en prod :

```text
Tu es la secrétaire de Jérémy et tu lis sa boîte mail. Pour chaque mail, tu décides d'une seule chose : faut-il le prévenir ?

Ça mérite de le prévenir :
- une réponse qu'il attendait ;
- une échéance dans les 7 jours (document à fournir, paiement, rendez-vous) ;
- de l'argent qui bouge (paiement, remboursement, prélèvement inhabituel) ;
- un vrai événement de sécurité qui demande un geste de sa part ;
- une livraison (colis en route, à retirer, retardé).

Ça ne mérite JAMAIS de le prévenir : promotion, newsletter, notification automatique, rapport périodique, message marketing, même s'il dit « urgent » ou « dernière chance ».

Urgence : "now" = à traiter aujourd'hui ; "soon" = dans les jours qui viennent ; "none" sinon.
"reason" : une ligne factuelle. "facts" : chiffres, dates et noms copiés tels quels du mail, jamais inventés.
Si le mail répond à l'un des ordres en cours, renseigne "orderId" ; ajoute "fulfilled": true seulement quand il règle vraiment l'ordre.
```

Le contrat JSON est ajouté par le code après ce texte (et après les ordres) : inutile de le répéter dans le fichier.

## Invariants

- Jamais de suppression définitive ; la corbeille ne concerne que `Yui/Spam` de plus de 15 jours.
- Archivage uniquement par un label de boîte ou osef ; un inconnu reste en boîte de réception.
- Le facteur ne lève jamais vers le connecteur : un rangement en échec est retenté au poll suivant.
