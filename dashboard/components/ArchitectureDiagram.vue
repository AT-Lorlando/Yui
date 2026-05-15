<template>
  <ClientOnly>
    <div ref="container" class="w-full overflow-x-auto" />
    <template #fallback>
      <div class="flex justify-center py-8">
        <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
      </div>
    </template>
  </ClientOnly>
</template>

<script setup lang="ts">
import mermaid from 'mermaid'

const props = defineProps<{
  servers?: { name: string }[]
}>()

const FALLBACK_SERVERS = [
  'hue', 'nuki', 'spotify', 'chromecast', 'samsung',
  'timer', 'calendar', 'gmail', 'weather', 'obsidian', 'linear', 'somfy',
]

const resolvedServers = computed(() =>
  props.servers?.length
    ? props.servers.map((s) => s.name.replace('mcp-', ''))
    : FALLBACK_SERVERS,
)

const colorMode = useColorMode()
const container = ref<HTMLElement>()

function buildDiagram(servers: string[]): string {
  const deviceNodes = servers
    .map((s) => `        ${s}["${s}"]`)
    .join('\n')

  return `flowchart TD
    %% ── Clients externes ────────────────────────────────────────
    Mobile["📱 App Mobile\\nReact Native"]
    SatHw["🎤 Micro ReSpeaker\\nRaspberry Pi satellite"]
    Browser["🌐 Navigateur\\nDashboard web"]

    %% ── yui-voice ───────────────────────────────────────────────
    subgraph proc_voice ["  yui-voice  —  Python  "]
        direction TB
        Porcupine["Porcupine\\nwakeword"]
        VAD["Silero VAD\\ndébut / fin de parole"]
        Whisper["Whisper large-v3-turbo\\ntranscription STT"]
        Porcupine --> VAD --> Whisper
    end

    %% ── yui-main : Dashboard Nuxt (port 3001) ───────────────────
    subgraph proc_main ["  yui-main  —  Nuxt 3 · port 3001  "]
        direction TB
        subgraph nuxt_front ["Dashboard frontend"]
            direction LR
            PageDash["page /\\nPM2 · MCP · Status"]
            PageTools["page /tools\\nMCP Playground"]
        end
        ProxyLayer["routeRules proxy\\n/status /tools /order /devices /scenes…\\n→ ORCHESTRATOR_URL"]
        nuxt_front --> ProxyLayer
    end

    %% ── yui-orchestrator : Orchestrateur (port 3000) ────────────
    subgraph proc_orch ["  yui-orchestrator  —  Node.js · port 3000  "]
        direction TB
        subgraph orch ["Orchestrateur"]
            direction TB
            LLM["🤖 LLM Deepseek\\nvia API OpenAI-compat"]
            MCPClients["MCP Clients\\n(un client par server)"]
            VirtualTools["Virtual Tools\\nmémoire · scènes · timers"]
            LLM -- "tool calls" --> MCPClients
            LLM -- "tool calls" --> VirtualTools
        end
    end

    %% ── MCP Servers (processus enfants de yui-orchestrator) ─────
    subgraph proc_mcp ["  Serveurs MCP  —  processus enfants Node.js  (spawn au démarrage)"]
        direction LR
${deviceNodes}
    end

    %% ── yui-tts-engine ──────────────────────────────────────────
    subgraph proc_tts ["  yui-tts-engine  —  Python  "]
        XTTS["XTTS v2\\nAna Florence · speed 1.15"]
    end

    Speaker["🔊 Google Home Max\\n10.0.0.192 — Salon"]

    %% ── Flux ─────────────────────────────────────────────────────
    SatHw -- "UDP audio\\nstream" --> proc_voice
    Whisper -- "POST /order\\nHTTP Bearer\\nport 3000" --> proc_orch

    Mobile -- "POST /order\\nHTTP Bearer\\nport 3000" --> proc_orch
    Browser -- "HTTP port 3001" --> proc_main
    ProxyLayer -- "HTTP proxy\\nport 3000" --> proc_orch

    MCPClients -- "stdio / JSON-RPC" --> proc_mcp

    orch -- "POST /speak\\nHTTP" --> proc_tts
    XTTS -- "cast audio\\nChromecast API" --> Speaker`
}

async function render() {
  if (!container.value) return

  const isDark = colorMode.value === 'dark'
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'neutral',
    flowchart: { curve: 'basis', padding: 20 },
    themeVariables: isDark
      ? { primaryColor: '#1e3a5f', primaryTextColor: '#e2e8f0', lineColor: '#64748b' }
      : { primaryColor: '#dbeafe', primaryTextColor: '#1e3a5f', lineColor: '#94a3b8' },
  })

  const id = 'yui-arch-' + Date.now()
  const { svg } = await mermaid.render(id, buildDiagram(resolvedServers.value))
  container.value.innerHTML = svg
}

onMounted(render)
watch(() => colorMode.value, render)
watch(() => props.servers, render)
</script>
