<template>
  <div class="py-6 space-y-6">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-bold">Automations</h1>
        <UBadge v-if="automations?.length" color="gray" variant="subtle" :label="`${automations.length} automation${automations.length > 1 ? 's' : ''}`" />
      </div>
      <div class="flex items-center gap-2">
        <UDropdown :items="templateItems">
          <UButton icon="i-heroicons-document-duplicate" size="sm" variant="ghost" color="gray">Modèles</UButton>
        </UDropdown>
        <UButton icon="i-heroicons-plus" size="sm" to="/schedules/new">Nouvelle automation</UButton>
      </div>
    </div>

    <div v-if="pending" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
    </div>

    <div v-else-if="error" class="text-center py-12 text-gray-400">
      <UIcon name="i-heroicons-signal-slash" class="text-4xl mb-2" />
      <p>Orchestrator non disponible</p>
    </div>

    <div v-else-if="!automations?.length" class="text-center py-12 text-gray-400">
      <UIcon name="i-heroicons-clock" class="text-5xl mb-3" />
      <p class="font-medium">Aucune automation</p>
      <p class="text-sm mt-1">Demande à Yui de créer une automation pour commencer.</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="a in automations"
        :key="a.id"
        class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-5 py-4 flex items-start gap-4"
      >
        <!-- Status indicator -->
        <div class="mt-0.5 shrink-0">
          <div
            class="w-2.5 h-2.5 rounded-full mt-1"
            :class="a.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'"
          />
        </div>

        <!-- Content -->
        <div class="flex-1 min-w-0 space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold text-sm">{{ a.name }}</span>
            <UBadge :color="triggerColor(a)" variant="subtle" size="xs" :label="triggerLabel(a)" />
            <UBadge :color="a.action.type === 'scene' ? 'blue' : 'purple'" variant="subtle" size="xs" :label="a.action.type" />
            <UBadge :color="a.enabled ? 'green' : 'gray'" variant="subtle" size="xs" :label="a.enabled ? 'actif' : 'désactivé'" />
          </div>

          <div class="flex items-center gap-2 text-xs text-gray-500">
            <UIcon name="i-heroicons-clock" class="shrink-0" />
            <code class="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-xs">{{ triggerDetail(a) }}</code>
            <span v-if="a.action.type === 'prompt' && a.action.output && a.action.output !== 'none'" class="text-gray-400">
              → {{ a.action.output }}
            </span>
          </div>

          <p v-if="a.action.type === 'prompt'" class="text-xs text-gray-400 italic truncate">"{{ a.action.text }}"</p>
          <p v-else class="text-xs text-gray-400 italic truncate">scène : {{ a.action.sceneId }}</p>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-2 shrink-0">
          <UButton
            size="xs"
            variant="ghost"
            icon="i-heroicons-pencil-square"
            color="gray"
            :to="`/schedules/${a.id}`"
          />
          <UButton
            size="xs"
            variant="ghost"
            icon="i-heroicons-play"
            color="blue"
            :loading="runLoading[a.id]"
            @click="run(a.id)"
          />
          <UButton
            size="xs"
            variant="ghost"
            :icon="a.enabled ? 'i-heroicons-pause' : 'i-heroicons-play'"
            :color="a.enabled ? 'yellow' : 'green'"
            :loading="toggleLoading[a.id]"
            @click="toggle(a.id)"
          />
          <UButton
            size="xs"
            variant="ghost"
            icon="i-heroicons-trash"
            color="red"
            :loading="deleteLoading[a.id]"
            @click="remove(a.id)"
          />
        </div>
      </div>
    </div>

    <!-- History -->
    <div class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 overflow-hidden">
      <button
        class="w-full flex items-center justify-between px-5 py-4 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
        @click="historyOpen = !historyOpen"
      >
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-clock-rotate-left" class="text-gray-400" />
          <span>Historique</span>
          <UBadge v-if="history?.length" color="gray" variant="subtle" size="xs" :label="`${history.length}`" />
        </div>
        <UIcon :name="historyOpen ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'" class="text-gray-400" />
      </button>

      <div v-if="historyOpen" class="divide-y divide-gray-100 dark:divide-gray-700">
        <div v-if="!history?.length" class="px-5 py-8 text-center text-gray-400 text-sm">
          Aucune automation dans l'historique.
        </div>
        <div
          v-for="entry in history"
          :key="`${entry.id}-${entry.firedAt}`"
          class="flex items-center justify-between px-5 py-3 gap-4"
        >
          <div class="flex-1 min-w-0 space-y-0.5">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-medium">{{ entry.name }}</span>
              <UBadge :color="entry.action.type === 'scene' ? 'blue' : 'purple'" variant="subtle" size="xs" :label="entry.action.type" />
            </div>
            <p class="text-xs text-gray-400">
              {{ relativeTime(entry.firedAt) }}
              <span v-if="entry.action.type === 'prompt' && entry.action.text" class="ml-1 italic">· "{{ entry.action.text.slice(0, 60) }}{{ entry.action.text.length > 60 ? '…' : '' }}"</span>
              <span v-else-if="entry.action.type === 'scene'" class="ml-1 italic">· scène : {{ entry.action.sceneId }}</span>
            </p>
          </div>
          <UButton
            size="xs"
            variant="ghost"
            icon="i-heroicons-arrow-path"
            color="gray"
            :to="recreateUrl(entry)"
          >
            Recréer
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface AutomationTrigger {
  type: 'cron' | 'delay'
  expr?: string
  ms?: number
  fireAt?: number
}

interface AutomationAction {
  type: 'scene' | 'prompt'
  sceneId?: string
  text?: string
  output?: string
}

interface Automation {
  id: string
  name: string
  trigger: AutomationTrigger
  action: AutomationAction
  notify?: string | null
  enabled: boolean
  createdAt: number
}

const { $api } = useNuxtApp()
const toast = useToast()
const router = useRouter()

const templateItems = [[
  {
    label: 'Briefing matinal',
    icon: 'i-heroicons-sun',
    click: () => router.push('/schedules/new?template=morning_briefing'),
  },
]]

const { data: automations, pending, error, refresh } = await useAsyncData<Automation[]>(
  'automations',
  () => $api('/api/orch/automations'),
  { default: () => [] },
)

interface HistoryEntry {
  id: string
  name: string
  action: {
    type: 'scene' | 'prompt'
    sceneId?: string
    text?: string
    output?: string
  }
  firedAt: number
}

const { data: history, refresh: refreshHistory } = await useAsyncData<HistoryEntry[]>(
  'automation-history',
  () => $api('/api/orch/automations/history'),
  { default: () => [] },
)

const historyOpen = ref(false)

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return "à l'instant"
  if (diff < 3_600_000) return `il y a ${Math.floor(diff / 60_000)} min`
  if (diff < 86_400_000) return `il y a ${Math.floor(diff / 3_600_000)} h`
  return `il y a ${Math.floor(diff / 86_400_000)} j`
}

function recreateUrl(entry: HistoryEntry): string {
  const params = new URLSearchParams({ name: entry.name, actionType: entry.action.type })
  if (entry.action.type === 'prompt') {
    if (entry.action.text) params.set('promptText', entry.action.text)
    params.set('promptOutput', entry.action.output ?? 'cast')
  } else {
    if (entry.action.sceneId) params.set('sceneId', entry.action.sceneId)
  }
  return `/schedules/new?${params.toString()}`
}

const toggleLoading = ref<Record<string, boolean>>({})
const deleteLoading = ref<Record<string, boolean>>({})
const runLoading = ref<Record<string, boolean>>({})

function triggerLabel(a: Automation): string {
  return a.trigger.type === 'cron' ? 'cron' : 'minuteur'
}

function triggerColor(a: Automation): string {
  return a.trigger.type === 'cron' ? 'orange' : 'yellow'
}

function formatDiff(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)} j`
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round(ms / 1_000)} s`
}

function triggerDetail(a: Automation): string {
  if (a.trigger.type === 'cron') return a.trigger.expr ?? ''
  if (a.trigger.fireAt) {
    const diff = a.trigger.fireAt - Date.now()
    if (diff <= 0) return 'expiré'
    return `dans ${formatDiff(diff)}`
  }
  return formatDiff(a.trigger.ms ?? 0)
}

async function toggle(id: string) {
  toggleLoading.value[id] = true
  try {
    const res = await $api<{ message: string }>(`/api/orch/automations/${id}/toggle`, { method: 'PATCH' })
    toast.add({ title: res.message, color: 'green' })
    await refresh()
  } catch (e: any) {
    toast.add({ title: 'Erreur', description: e?.data?.error ?? String(e), color: 'red' })
  } finally {
    toggleLoading.value[id] = false
  }
}

async function run(id: string) {
  runLoading.value[id] = true
  try {
    await $api(`/api/orch/automations/${id}/run`, { method: 'POST' })
    toast.add({ title: 'Automation déclenchée', color: 'green' })
  } catch (e: any) {
    toast.add({ title: 'Erreur', description: e?.data?.error ?? String(e), color: 'red' })
  } finally {
    runLoading.value[id] = false
  }
}

async function remove(id: string) {
  deleteLoading.value[id] = true
  try {
    await $api(`/api/orch/automations/${id}`, { method: 'DELETE' })
    toast.add({ title: 'Automation supprimée', color: 'green' })
    await refresh()
  } catch (e: any) {
    toast.add({ title: 'Erreur', description: e?.data?.error ?? String(e), color: 'red' })
  } finally {
    deleteLoading.value[id] = false
  }
}
</script>
