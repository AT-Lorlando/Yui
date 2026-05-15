<template>
  <div class="py-6 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Routines</h1>
      <UBadge v-if="schedules?.length" color="gray" variant="subtle" :label="`${schedules.length} routine${schedules.length > 1 ? 's' : ''}`" />
    </div>

    <div v-if="pending" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
    </div>

    <div v-else-if="error" class="text-center py-12 text-gray-400">
      <UIcon name="i-heroicons-signal-slash" class="text-4xl mb-2" />
      <p>Orchestrator non disponible</p>
    </div>

    <div v-else-if="!schedules?.length" class="text-center py-12 text-gray-400">
      <UIcon name="i-heroicons-clock" class="text-5xl mb-3" />
      <p class="font-medium">Aucune routine</p>
      <p class="text-sm mt-1">Demande à Yui de créer une routine pour commencer.</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="s in schedules"
        :key="s.id"
        class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-5 py-4 flex items-start gap-4"
      >
        <!-- Status indicator -->
        <div class="mt-0.5 shrink-0">
          <div
            class="w-2.5 h-2.5 rounded-full mt-1"
            :class="s.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'"
          />
        </div>

        <!-- Content -->
        <div class="flex-1 min-w-0 space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold text-sm">{{ s.name }}</span>
            <UBadge v-if="s.oneshot" color="yellow" variant="subtle" size="xs" label="one-shot" />
            <UBadge :color="s.enabled ? 'green' : 'gray'" variant="subtle" size="xs" :label="s.enabled ? 'actif' : 'désactivé'" />
          </div>

          <div class="flex items-center gap-2 text-xs text-gray-500">
            <UIcon name="i-heroicons-clock" class="shrink-0" />
            <code class="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-xs">{{ s.cron }}</code>
            <span v-if="s.output && s.output !== 'none'" class="text-gray-400">→ {{ s.output }}</span>
          </div>

          <p class="text-xs text-gray-400 italic truncate">"{{ s.prompt }}"</p>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-2 shrink-0">
          <UButton
            size="xs"
            variant="ghost"
            :icon="s.enabled ? 'i-heroicons-pause' : 'i-heroicons-play'"
            :color="s.enabled ? 'yellow' : 'green'"
            :loading="toggleLoading[s.id]"
            @click="toggle(s.id)"
          />
          <UButton
            size="xs"
            variant="ghost"
            icon="i-heroicons-trash"
            color="red"
            :loading="deleteLoading[s.id]"
            @click="remove(s.id)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Schedule {
  id: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
  output?: string
  oneshot?: boolean
}

const { $api } = useNuxtApp()
const toast = useToast()

const { data: schedules, pending, error, refresh } = await useAsyncData<Schedule[]>(
  'schedules',
  () => $api('/api/orch/schedules'),
  { default: () => [] },
)

const toggleLoading = ref<Record<string, boolean>>({})
const deleteLoading = ref<Record<string, boolean>>({})

async function toggle(id: string) {
  toggleLoading.value[id] = true
  try {
    const res = await $api<{ message: string }>(`/api/orch/schedules/${id}/toggle`, { method: 'PATCH' })
    toast.add({ title: res.message, color: 'green' })
    await refresh()
  } catch (e: any) {
    toast.add({ title: 'Erreur', description: e?.data?.error ?? String(e), color: 'red' })
  } finally {
    toggleLoading.value[id] = false
  }
}

async function remove(id: string) {
  deleteLoading.value[id] = true
  try {
    await $api(`/api/orch/schedules/${id}`, { method: 'DELETE' })
    toast.add({ title: 'Routine supprimée', color: 'green' })
    await refresh()
  } catch (e: any) {
    toast.add({ title: 'Erreur', description: e?.data?.error ?? String(e), color: 'red' })
  } finally {
    deleteLoading.value[id] = false
  }
}
</script>
