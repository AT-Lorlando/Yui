# @yui/mcp-nuki

Serveur MCP pour le controle des serrures connectees Nuki.

## Setup (premiere utilisation)

Trouver l'IP du bridge Nuki dans l'app Nuki : **Manage Bridge > IP address**.

Lancer le script de configuration :

```bash
npm run setup:nuki -- 192.168.1.50       # port par defaut : 8080
npm run setup:nuki -- 192.168.1.50 8080  # port explicite
```

Le script va :
1. Se connecter au bridge Nuki a l'adresse donnee
2. Demander d'appuyer sur le **bouton du bridge** (30 secondes)
3. Creer un token API via `/auth`
4. Ecrire `NUKI_HOST`, `NUKI_PORT` et `NUKI_TOKEN` dans le `.env` racine
5. Valider la connexion en listant les serrures

Prerequis : l'option **"Allow access"** doit etre activee dans l'app Nuki (Manage Bridge > Allow access).

Sortie attendue :
```
=== Yui — Nuki Bridge Setup ===

Bridge: http://192.168.1.50:8080
Token:  a1b2c3d4e5

Credentials written to /path/to/Yui/.env

Validating connection...

=== Setup complete ===
Bridge: http://192.168.1.50:8080
Token:  a1b2c3d4e5
Locks:  2
  - Porte entree (id: 123456789, type: 0)
  - Porte garage (id: 987654321, type: 0)

You can now run: npm run dev:nuki
```

## Run (usage quotidien)

**En production** — le serveur est spawne automatiquement par l'orchestrateur comme processus enfant (stdio). Rien a faire.

**En standalone** (test/debug) :

```bash
npm run dev:nuki     # depuis la racine du monorepo
```

Requiert `NUKI_HOST`, `NUKI_PORT` et `NUKI_TOKEN` dans le `.env`. Si l'une des variables manque, le serveur refuse de demarrer avec un message explicite.

## Outils MCP

| Outil | Description |
|---|---|
| `list_doors` | Liste toutes les serrures avec leur etat |
| `lock_door` | Verrouille une serrure par ID |
| `unlock_door` | Deverrouille une serrure par ID |
| `get_door_state` | Etat detaille d'une serrure (toujours en direct, securite) |
| `refresh_doors` | Re-decouverte complete depuis le bridge |

### Cache

- **Lecture** (`list_doors`) : sert depuis le cache, aucun appel bridge.
- **Mutation** (`lock_door`, `unlock_door`) : appel bridge en direct, puis mise a jour du cache.
- **Etat** (`get_door_state`) : toujours en direct (securite critique), mise a jour du cache.
- **Refresh** (`refresh_doors`) : re-decouverte complete depuis le bridge.

## Architecture

```
index.ts            Point d'entree, handlers MCP, pipeline main()
NukiBridge.ts       Connexion au bridge (prod: env vars, setup: /auth token)
NukiController.ts   Operations serrures (lock, unlock, state)
discovery.ts        Decouverte serrures, peuplement du cache
setup.ts            Script de configuration interactif
tools.ts            Definitions des outils MCP
logger.ts           Re-export du logger partage
```
