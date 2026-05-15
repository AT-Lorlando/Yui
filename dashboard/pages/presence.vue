<template>
  <div class="py-6 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Présence</h1>
      <UButton icon="i-heroicons-arrow-path" variant="ghost" color="gray" size="xs" :loading="pending" @click="refresh" />
    </div>

    <div v-if="pending && !data" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
    </div>

    <div v-else>
      <!-- État actuel -->
      <UCard class="mb-6">
        <div class="flex items-center gap-6">
          <div
            class="w-16 h-16 rounded-full flex items-center justify-center text-3xl"
            :class="stateStyle.bg"
          >
            <UIcon :name="stateStyle.icon" :class="stateStyle.color" />
          </div>
          <div>
            <p class="text-sm text-gray-500 uppercase tracking-wide font-medium">État actuel</p>
            <p class="text-3xl font-bold mt-1" :class="stateStyle.color">{{ stateStyle.label }}</p>
          </div>
        </div>
      </UCard>

      <!-- Config -->
      <UCard>
        <template #header>
          <h2 class="text-sm font-semibold">Configuration</h2>
        </template>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div v-for="item in config" :key="item.label" class="space-y-1">
            <p class="text-xs text-gray-500 uppercase tracking-wide">{{ item.label }}</p>
            <p class="text-sm font-mono text-gray-700 dark:text-gray-300">{{ item.value }}</p>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>

<script setup lang="ts">
const { $api } = useNuxtApp()

const { data, pending, refresh } = await useAsyncData<{ state: string }>(
  'presence',
  () => $api('/api/orch/presence'),
)

// Refresh every 30s
let interval: ReturnType<typeof setInterval> | null = null
onMounted(() => { interval = setInterval(refresh, 30_000) })
onUnmounted(() => { if (interval) clearInterval(interval) })

const stateStyle = computed(() => {
  const s = data.value?.state ?? 'unknown'
  if (s === 'home') return {
    label: 'Présent',
    icon: 'i-heroicons-home',
    color: 'text-green-500',
    bg: 'bg-green-50 dark:bg-green-900/20',
  }
  if (s === 'away') return {
    label: 'Absent',
    icon: 'i-heroicons-arrow-right-start-on-rectangle',
    color: 'text-orange-500',
    bg: 'bg-orange-50 dark:bg-orange-900/20',
  }
  return {
    label: 'Inconnu',
    icon: 'i-heroicons-question-mark-circle',
    color: 'text-gray-400',
    bg: 'bg-gray-50 dark:bg-gray-800',
  }
})

const runtimeConfig = useRuntimeConfig()

const config = [
  { label: 'Scène départ', value: import.meta.env.VITE_DEPARTURE_SCENE ?? 'depart-maison' },
  { label: 'Scène retour', value: import.meta.env.VITE_ARRIVAL_SCENE ?? 'retour-maison' },
  { label: 'Timeout départ', value: '15 min' },
  { label: 'Rayon arrivée', value: '200 m' },
  { label: 'Polling MAC', value: '2 min' },
]
</script>
