# @yui/mcp-smartthings

Contrôle de la TV Samsung via l'API cloud **SmartThings** (volume absolu, mute,
entrée HDMI, statut réel, on/off). L'allumage passe par **Wake-on-LAN local**
(la TV ne supporte pas l'allumage cloud : `supportsPowerOnByOcf = false`).

La logique TV vit dans `@yui/shared` (`SmartThingsAuth`, `SmartThingsClient`,
`SmartThingsBackend`, `TvBackend`, `wakeOnLan`). Ce package est le **seul**
process à toucher le cloud SmartThings — il détient et rafraîchit le refresh
token (qui est **rotaté** à chaque refresh). `mcp-chromecast` reste 100% local
(`LocalTizenBackend` = WoL + `KEY_HDMI3`), sans cloud ni token.

## Tools exposés au LLM

| Tool | Action |
| --- | --- |
| `tv_on` | WoL → attend ONLINE → bascule sur l'entrée Chromecast |
| `tv_off` | `switch:off` |
| `tv_volume` (`level` 0–100) | volume absolu |
| `tv_mute` (`mute` bool) | mute / unmute |
| `tv_set_input` (`source`) | change l'entrée (HDMI3, HDMI2, dtv…) |
| `tv_status` | état réel : on/off, volume, mute, entrée |

## Setup

### 1. Créer une app OAuth-In SmartThings

> ⚠️ Le CLI `smartthings apps:create` est cassé sur les versions récentes
> (`TypeError: Invalid URL / ERR_INVALID_URL` au moment de « Finish and create »),
> et son login interactif ne marche pas en SSH headless. On crée l'app
> **directement via l'API REST**, ce qui contourne les deux problèmes.

Il faut un Personal Access Token avec le scope **Apps** (`r:apps`, `w:apps`) en
plus de Devices — créé sur <https://account.smartthings.com/tokens>.

```bash
PAT=<ton-personal-access-token>
curl -s -X POST https://api.smartthings.com/v1/apps \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d '{
    "appName": "yui-mcp",
    "displayName": "Yui",
    "description": "Yui mcp",
    "appType": "API_ONLY",
    "classifications": ["CONNECTED_SERVICE"],
    "singleInstance": true,
    "apiOnly": {},
    "principalType": "LOCATION",
    "oauth": {
      "clientName": "Yui",
      "scope": ["r:devices:*", "w:devices:*", "x:devices:*"],
      "redirectUris": ["https://api.smartthings.com/installedapp"]
    }
  }' | python3 -m json.tool
```

La réponse contient **`oauthClientId`** et **`oauthClientSecret`** (notés une
seule fois). N'appelle `oauth/generate` qu'en dernier recours : chaque appel
**rotate le secret** (invalide le précédent) et peut empiler des scopes.

> ⚠️ **Le `redirectUri` doit être HTTPS** (les apps API_ONLY rejettent
> `http://localhost` → 403). Le défaut `https://api.smartthings.com/installedapp`
> est **le domaine de SmartThings lui-même** : le `code` ne transite par aucun
> tiers (l'émetteur l'a déjà), et il est auto-enregistré sur l'app. On lit le
> `code` dans la **barre d'adresse** du navigateur après redirection.
> **N'utilise pas** un echo public (httpbin, webhook.site…) comme redirect : ça
> ferait fuiter ton code d'autorisation vers un tiers. Si tu mets ton propre
> endpoint HTTPS, aligne `SMARTTHINGS_REDIRECT_URI` et l'app (PUT
> `/v1/apps/yui-mcp/oauth`).

### 2. Renseigner les credentials

Dans `.env` à la racine :

```
SMARTTHINGS_CLIENT_ID=<oauthClientId>
SMARTTHINGS_CLIENT_SECRET=<oauthClientSecret>
# optionnel : forcer le device TV (sinon auto-détecté par type "TV")
SMARTTHINGS_DEVICE_ID=<deviceId de la TV>
# optionnel : surcharger le redirect HTTPS (défaut https://api.smartthings.com/installedapp)
SMARTTHINGS_REDIRECT_URI=
```

### 3. Lancer le flow OAuth (mode collage, headless-friendly)

```bash
npm run setup:smartthings
```

Le script **n'ouvre pas de serveur local** : il affiche une URL d'autorisation.
1. Ouvre-la dans un navigateur (n'importe quelle machine), autorise Yui en
   **sélectionnant la Location qui contient la TV**.
2. Tu es redirigé vers `https://api.smartthings.com/installedapp?code=...&state=...`
   (la page peut afficher une erreur, peu importe).
3. **Copie l'URL COMPLÈTE depuis la barre d'adresse** (elle contient `code` +
   `state`) et colle-la dans le terminal.

Le script vérifie le `state` (CSRF, **fail-closed** — l'URL complète est requise),
échange le code, liste tes devices pour trouver la TV, et écrit
`data/shared/smartthings.json` (`{ clientId, clientSecret, refreshToken,
deviceId }`, perms `0600`). Aucun tunnel SSH nécessaire.

> Le `code` est à usage unique et expire vite : si l'échange échoue, relance le
> setup pour repartir d'une URL fraîche.

## Fichiers de données

| Fichier | Rôle |
| --- | --- |
| `data/shared/smartthings.json` | credentials OAuth + deviceId (jamais commité, `0600`, refresh token **rotaté** à chaque refresh) |
| `data/state/smartthings-token.json` | cache de l'access token (24h, régénérable) |
| `data/config/smartthings-tv.json` | config TV non-secrète : `mac`, `ip`, `chromecastInput`, map des `inputs` (défauts intégrés si absent) |

## Limites connues (validées matériellement)

- **Allumage cloud impossible** (`supportsPowerOnByOcf=false`) → WoL local obligatoire.
- **TV éteinte = `OFFLINE` côté cloud** → toutes les commandes échouent
  (`ConflictError`, traduit en « La télé est éteinte. »). SmartThings ne pilote
  que TV allumée + connectée.
- **Feedback d'état paresseux** : `tv_status` envoie une commande `refresh` puis
  relit (~2 s) car les `GET status` sont sinon périmés.
- **Refresh token** : rotaté à chaque refresh, expire après ~30 j d'inactivité ;
  l'app SmartThings doit être utilisée au moins une fois /28 j sinon le device
  est désappairé.
