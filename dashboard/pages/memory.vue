<template>
  <div class="py-6 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Mémoire</h1>
      <UBadge v-if="namespaces.length" color="gray" variant="subtle" :label="`${namespaces.length} namespace${namespaces.length > 1 ? 's' : ''}`" />
    </div>

    <div v-if="pending" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
    </div>

    <div v-else-if="!namespaces.length" class="text-center py-12 text-gray-400">
      <UIcon name="i-heroicons-archive-box" class="text-5xl mb-3" />
      <p class="font-medium">Aucune mémoire enregistrée</p>
      <p class="text-sm mt-1">Dis à Yui "souviens-toi que…" pour créer une entrée.</p>
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="ns in namespaces"
        :key="ns.name"
        class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 overflow-hidden"
      >
        <!-- Namespace header -->
        <div class="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-folder" class="text-gray-400" />
            <span class="font-semibold text-sm">{{ ns.name }}</span>
          </div>
          <div class="flex items-center gap-2">
            <UBadge
              :color="ns.priority === 'always' ? 'primary' : 'gray'"
              variant="subtle"
              size="xs"
              :label="ns.priority === 'always' ? 'always' : 'on-demand'"
            />
            <UBadge color="gray" variant="subtle" size="xs" :label="`${ns.entries.length} entrée${ns.entries.length > 1 ? 's' : ''}`" />
          </div>
        </div>

        <!-- Entries -->
        <div class="divide-y divide-gray-100 dark:divide-gray-700">
          <div
            v-for="entry in ns.entries"
            :key="entry.key"
            class="flex items-start gap-4 px-5 py-3"
          >
            <span class="text-xs font-mono text-gray-500 min-w-24 pt-0.5 shrink-0">{{ entry.key }}</span>
            <span class="text-sm text-gray-700 dark:text-gray-300 flex-1">{{ entry.value }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface MemoryStore {
  [namespace: string]: {
    _priority: 'always' | 'on-demand'
    [key: string]: string
  }
}

interface Namespace {
  name: string
  priority: 'always' | 'on-demand'
  entries: { key: string; value: string }[]
}

const { $api } = useNuxtApp()

const { data: raw, pending } = await useAsyncData<MemoryStore>(
  'memory',
  () => $api('/api/orch/memory'),
  { default: () => ({}) },
)

const namespaces = computed<Namespace[]>(() => {
  const store = raw.value ?? {}
  return Object.entries(store).map(([name, data]) => ({
    name,
    priority: data._priority ?? 'always',
    entries: Object.entries(data)
      .filter(([k]) => k !== '_priority')
      .map(([key, value]) => ({ key, value })),
  }))
})
</script>
