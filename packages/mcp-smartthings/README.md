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
      "redirectUris": ["http://localhost:6147/callback"]
    }
  }' | python3 -m json.tool
```

La réponse contient **`oauthClientId`** et **`oauthClientSecret`** (notés une
seule fois). Si le secret manque, régénère-le :

```bash
curl -s -X POST "https://api.smartthings.com/v1/apps/yui-mcp/oauth/generate" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d '{"clientName":"Yui","scope":["r:devices:*","w:devices:*","x:devices:*"],"redirectUris":["http://localhost:6147/callback"]}' \
  | python3 -m json.tool
```

> Le `redirectUris` **doit** être exactement `http://localhost:6147/callback`
> (port utilisé par `setup:smartthings`). `localhost` est accepté par les apps
> OAuth-In.

### 2. Renseigner les credentials

Dans `.env` à la racine :

```
SMARTTHINGS_CLIENT_ID=<oauthClientId>
SMARTTHINGS_CLIENT_SECRET=<oauthClientSecret>
# optionnel : forcer le device TV (sinon auto-détecté par type "TV")
SMARTTHINGS_DEVICE_ID=<deviceId de la TV>
# optionnel : surcharger le redirect (défaut http://localhost:6147/callback)
SMARTTHINGS_REDIRECT_URI=
```

### 3. Lancer le flow OAuth

```bash
npm run setup:smartthings
```

Le script ouvre le flow Authorization Code (consentement navigateur), liste tes
devices pour trouver la TV, et écrit `data/shared/smartthings.json`
(`{ clientId, clientSecret, refreshToken, deviceId }`, perms `0600`).

> **Serveur headless (SSH) :** le flow a besoin d'un navigateur + du callback sur
> `localhost:6147`. Ouvre un tunnel depuis ta machine avec navigateur :
> ```bash
> ssh -L 6147:localhost:6147 user@serveur
> # puis sur le serveur : npm run setup:smartthings
> # ouvre l'URL d'autorisation affichée dans le navigateur de ta machine ;
> # la redirection vers localhost:6147 repart dans le tunnel jusqu'au serveur
> ```
> Le serveur de callback bind `127.0.0.1` (compatible `ssh -L`).

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
