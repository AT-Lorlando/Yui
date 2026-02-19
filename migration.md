# Architecture Yui — MCP Monorepo

### Vue d'ensemble

Yui est un orchestrateur de maison intelligente en langage naturel. L'utilisateur saisit un ordre textuel, le LLM décide quels outils appeler, et les outils pilotent les équipements physiques via des serveurs MCP indépendants.

---

### Flux d'exécution

```
Utilisateur: "Turn on the living room light"
      │
      ▼
src/listener.ts          ← lit stdin (readline) ou HTTP POST /order
      │
      ▼
src/orchestrator.ts
  1. Collecte tous les tools des serveurs MCP (listTools)
  2. Envoie à OpenAI :
       messages: [{ role: "user", content: "Turn on the living room light" }]
       tools: [ list_lights, turn_on_light, ... lock_door, unlock_door, ... ]
      │
      ▼
  3. OpenAI répond : tool_call → turn_on_light({ lightId: 2 })
      │
      ▼
  4. Route vers le bon MCP client → client.callTool("turn_on_light", { lightId: 2 })
      │
      ▼
packages/mcp-hue/src/index.ts   ← process fils (stdio)
  → HueController.setLightState(2, true)
  → API Philips Hue
  → retourne: "Light 2 turned on successfully."
      │
      ▼
  5. Injecte le tool_result dans les messages
  6. Renvoie au LLM → réponse finale : "I've turned on the living room light."
      │
      ▼
Utilisateur voit la réponse
```

---

### Structure monorepo

```
Yui/
├── src/                      # Orchestrateur (process principal)
│   ├── main.ts               # Démarre l'orchestrateur, attache SIGINT/SIGTERM
│   ├── orchestrator.ts       # Cœur : connexion MCP + boucle tool_use
│   ├── listener.ts           # Entrées : stdin readline + HTTP Express
│   ├── env.ts                # Variables d'environnement typées
│   ├── logger.ts             # Winston
│   └── story.ts              # Sauvegarde l'historique → stories/
│
└── packages/
    ├── shared/               # Types et logger partagés (npm workspace)
    ├── mcp-hue/              # Serveur MCP Philips Hue (process fils)
    ├── mcp-nuki/             # Serveur MCP Nuki (process fils)
    └── mcp-browser/          # Serveur MCP Playwright — Phase 2
```

---

### Serveurs MCP

Chaque serveur MCP est un **process Node.js indépendant** communiquant via **stdio** (stdin/stdout JSON-RPC). L'orchestrateur les spawn au démarrage.

Structure interne de chaque package :

```
packages/mcp-xxx/src/
├── index.ts          # McpServer + StdioServerTransport + handlers
├── XxxController.ts  # Logique métier pure (appels API/hardware)
└── tools.ts          # Définitions des tools (nom, description, JSON Schema)
```

#### Protocole de communication

```
Orchestrateur                          Serveur MCP (stdio)
     │                                       │
     │──── spawn process (child_process) ───▶│
     │                                       │
     │──── {"method":"tools/list"} ─────────▶│
     │◀─── {"tools": [...]} ─────────────────│
     │                                       │
     │──── {"method":"tools/call",           │
     │      "name":"turn_on_light",          │
     │      "arguments":{"lightId":2}} ─────▶│
     │◀─── {"content":[{"type":"text",       │
     │      "text":"Light 2 turned on"}]} ───│
```

---

### Tools disponibles

| Serveur | Tool | Paramètres |
|---|---|---|
| mcp-hue | `list_lights` | — |
| mcp-hue | `turn_on_light` | `lightId: number` |
| mcp-hue | `turn_off_light` | `lightId: number` |
| mcp-hue | `set_brightness` | `lightId, brightness: 0-254` |
| mcp-hue | `set_color` | `lightId, color: string (hex)` |
| mcp-nuki | `list_doors` | — |
| mcp-nuki | `lock_door` | `nukiId: number, deviceType?` |
| mcp-nuki | `unlock_door` | `nukiId: number, deviceType?` |
| mcp-nuki | `get_door_state` | `nukiId: number, deviceType?` |
| mcp-browser | `open_browser` | `url: string` |
| mcp-browser | `get_page_content` | — |
| mcp-browser | `click_element` | `selector: string` |
| mcp-browser | `fill_input` | `selector, value: string` |
| mcp-browser | `close_browser` | — |

---

### Boucle tool_use (src/orchestrator.ts)

```
messages = [{ role: "system", ... }, { role: "user", content: order }]

loop (max 10 tours):
  response = openai.chat.completions.create({ messages, tools })

  si finish_reason === "stop"  →  réponse finale, sortir
  si tool_calls présents :
    pour chaque tool_call :
      trouver le MCP client qui expose ce tool
      résultat = client.callTool(toolName, args)
      ajouter { role: "tool", content: résultat } aux messages
  reboucler
```

Le LLM peut enchaîner plusieurs tool calls dans un même tour (ex : `list_lights` puis `turn_on_light`).

---

### Ajout d'un nouvel équipement

1. Créer `packages/mcp-xxx/` en copiant la structure de `mcp-nuki`
2. Implémenter `XxxController.ts` (appels à l'API matérielle)
3. Définir les tools dans `tools.ts` (nom + description + JSON Schema)
4. Brancher dans `index.ts` (switch/case sur le nom du tool)
5. Ajouter dans `src/orchestrator.ts` → `buildServerConfigs()` :
   ```typescript
   { name: 'mcp-xxx', command: 'npx', args: ['ts-node', '...path/index.ts'] }
   ```

Le LLM découvre automatiquement les nouveaux tools au prochain démarrage — aucun prompt à mettre à jour.

---

### Ce qui a changé vs l'ancienne architecture

| Avant | Après |
|---|---|
| Router LLM → specialist LLMs | Un seul LLM avec tous les tools |
| `eval()` sur méthodes d'entités | `client.callTool()` MCP |
| `Entity` + `Controller` couplés | Controller seul dans chaque package MCP |
| Prompts markdown + JSON docs | JSON Schema des tools (natif OpenAI) |
| Process monolithique | Process principal + N process fils MCP |
