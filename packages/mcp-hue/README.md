# @yui/mcp-hue

Serveur MCP pour le controle des lumieres Philips Hue.

## Setup (premiere utilisation)

Lancer le script de configuration interactif :

```bash
npm run setup:hue     # depuis la racine du monorepo
```

Le script va :
1. Decouvrir le bridge Hue sur le reseau local (nupnp)
2. Demander d'appuyer sur le bouton **link** du bridge (30 secondes)
3. Creer un utilisateur API
4. Ecrire `HUE_BRIDGE_IP` et `HUE_USERNAME` dans le `.env` racine
5. Valider la connexion en listant les lumieres

Sortie attendue :
```
=== Yui — Hue Bridge Setup ===

Bridge IP: 192.168.1.42
Username:  AbCdEf1234567890

Credentials written to /path/to/Yui/.env

Validating connection...

=== Setup complete ===
Bridge:  192.168.1.42
User:    AbCdEf1234567890
Rooms:   4
Lights:  12

You can now run: npm run dev:hue
```

## Run (usage quotidien)

**En production** — le serveur est spawne automatiquement par l'orchestrateur comme processus enfant (stdio). Rien a faire.

**En standalone** (test/debug) :

```bash
npm run dev:hue     # depuis la racine du monorepo
```

Requiert `HUE_BRIDGE_IP` et `HUE_USERNAME` dans le `.env`. Si l'une des variables manque, le serveur refuse de demarrer avec un message explicite.

## Outils MCP

| Outil | Description |
|---|---|
| `list_lights` | Liste toutes les lumieres avec leur etat |
| `turn_on_light` | Allume une lumiere par ID |
| `turn_off_light` | Eteint une lumiere par ID |
| `set_brightness` | Regle la luminosite (0-254), allume la lumiere |
| `set_color` | Regle la couleur (hex, ex: `#FF5500`) |
| `refresh_lights` | Re-decouverte complete depuis le bridge |

### Cache

- **Lecture** (`list_lights`) : sert depuis le cache, aucun appel bridge.
- **Mutation** (`turn_on_light`, `set_brightness`, etc.) : appel bridge en direct, puis mise a jour du cache.
- **Refresh** (`refresh_lights`) : re-decouverte complete depuis le bridge.

## Architecture

```
index.ts          Point d'entree, handlers MCP, pipeline main()
HueBridge.ts      Connexion au bridge (prod: env vars, setup: discovery + link-button)
HueController.ts  Operations lumieres (on/off, couleur, luminosite)
discovery.ts      Decouverte lumieres + groupes, peuplement du cache
setup.ts          Script de configuration interactif
tools.ts          Definitions des outils MCP
logger.ts         Re-export du logger partage
```
