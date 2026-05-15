<template>
  <div class="py-6 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Timers</h1>
      <div class="flex items-center gap-2">
        <UBadge v-if="active.length" color="green" variant="subtle" :label="`${active.length} actif${active.length > 1 ? 's' : ''}`" />
        <UButton icon="i-heroicons-arrow-path" variant="ghost" color="gray" size="xs" :loading="pending" @click="refresh" />
      </div>
    </div>

    <div v-if="pending && !timers?.length" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
    </div>

    <div v-else-if="!active.length" class="text-center py-12 text-gray-400">
      <UIcon name="i-heroicons-clock" class="text-5xl mb-3" />
      <p class="font-medium">Aucun timer actif</p>
      <p class="text-sm mt-1">Dis à Yui "mets un timer de 10 minutes".</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="t in active"
        :key="t.id"
        class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-5 py-4"
      >
        <div class="flex items-center justify-between mb-3">
          <div>
            <p class="font-semibold">{{ t.label }}</p>
            <p class="text-xs text-gray-400 mt-0.5">
              {{ t.room ? `Pièce : ${t.room} · ` : '' }}durée : {{ formatDuration(t.duration_seconds) }}
            </p>
          </div>
          <div class="text-right">
            <p class="text-2xl font-mono font-bold tabular-nums" :class="t.remaining_seconds < 60 ? 'text-red-500' : 'text-primary-500'">
              {{ formatRemaining(t.remaining_seconds) }}
            </p>
            <p class="text-xs text-gray-400">restantes</p>
          </div>
        </div>

        <!-- Progress bar -->
        <div class="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-1.5">
          <div
            class="h-1.5 rounded-full transition-all duration-1000"
            :class="t.remaining_seconds < 60 ? 'bg-red-500' : 'bg-primary-500'"
            :style="{ width: `${progress(t)}%` }"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface TimerEntry {
  id: string
  label: string
  duration_seconds: number
  started_at: number
  fires_at: number
  room?: string
  remaining_seconds: number
}

const { $api } = useNuxtApp()

const { data: timers, pending, refresh } = await useAsyncData<TimerEntry[]>(
  'timers',
  () => $api('/api/orch/timers'),
  { default: () => [] },
)

// Refresh every 5s to update countdown
let interval: ReturnType<typeof setInterval> | null = null
onMounted(() => { interval = setInterval(refresh, 5000) })
onUnmounted(() => { if (interval) clearInterval(interval) })

const active = computed(() =>
  (timers.value ?? []).filter((t) => t.remaining_seconds > 0),
)

function progress(t: TimerEntry): number {
  const elapsed = t.duration_seconds - t.remaining_seconds
  return Math.min(100, Math.round((elapsed / t.duration_seconds) * 100))
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m === 0) return `${sec}s`
  return sec > 0 ? `${m}min ${sec}s` : `${m}min`
}

function formatRemaining(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
</script>
