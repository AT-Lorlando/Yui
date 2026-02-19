# @yui/mcp-browser

Serveur MCP pour l'automatisation de navigateur via Playwright (Phase 2).

## Setup (premiere utilisation)

Installer les navigateurs Playwright :

```bash
npx playwright install chromium
```

Aucune variable d'environnement requise.

## Run (usage quotidien)

**En production** — le serveur est spawne automatiquement par l'orchestrateur comme processus enfant (stdio). Rien a faire.

**En standalone** (test/debug) :

```bash
npm run dev:browser     # depuis la racine du monorepo
```

## Outils MCP

| Outil | Description |
|---|---|
| `open_browser` | Ouvre un navigateur Chromium et navigue vers une URL |
| `get_page_content` | Recupere le contenu texte de la page courante |
| `click_element` | Clique sur un element par selecteur CSS |
| `fill_input` | Remplit un champ et soumet (Enter) |
| `close_browser` | Ferme le navigateur |

## Architecture

```
index.ts                Point d'entree, handlers MCP, pipeline main()
PlaywrightController.ts Operations navigateur (open, navigate, click, fill)
tools.ts                Definitions des outils MCP
logger.ts               Re-export du logger partage
```
