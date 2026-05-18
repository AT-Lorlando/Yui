<template>
  <div class="py-6 space-y-6">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-bold">Automations</h1>
        <UBadge v-if="automations?.length" color="gray" variant="subtle" :label="`${automations.length} automation${automations.length > 1 ? 's' : ''}`" />
      </div>
      <UButton icon="i-heroicons-plus" size="sm" to="/schedules/new">Nouvelle automation</UButton>
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

const { data: automations, pending, error, refresh } = await useAsyncData<Automation[]>(
  'automations',
  () => $api('/api/orch/automations'),
  { default: () => [] },
)

const toggleLoading = ref<Record<string, boolean>>({})
const deleteLoading = ref<Record<string, boolean>>({})
const runLoading = ref<Record<string, boolean>>({})

function triggerLabel(a: Automation): string {
  return a.trigger.type === 'cron' ? 'cron' : 'minuteur'
}

function triggerColor(a: Automation): string {
  return a.trigger.type === 'cron' ? 'orange' : 'yellow'
}

function triggerDetail(a: Automation): string {
  if (a.trigger.type === 'cron') return a.trigger.expr ?? ''
  if (a.trigger.fireAt) {
    const diff = a.trigger.fireAt - Date.now()
    if (diff <= 0) return 'expiré'
    const mins = Math.round(diff / 60000)
    return `dans ${mins} min`
  }
  return `${Math.round((a.trigger.ms ?? 0) / 60000)} min`
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
