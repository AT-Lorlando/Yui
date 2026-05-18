<template>
  <UModal v-model="isOpen" :ui="{ width: 'sm:max-w-2xl' }">
    <div class="flex h-[480px] overflow-hidden rounded-xl">
      <!-- Left: category groups -->
      <div class="w-44 shrink-0 border-r border-gray-200 dark:border-gray-700 overflow-y-auto py-2">
        <p class="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide">Catégorie</p>
        <button
          v-for="{ group } in groupedServers"
          :key="group"
          class="w-full text-left px-3 py-2 text-sm transition-colors"
          :class="selectedGroup === group
            ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400 font-medium'
            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
          @click="selectedGroup = group"
        >
          {{ group }}
        </button>
      </div>

      <!-- Right: tools for selected group -->
      <div class="flex-1 overflow-y-auto py-2">
        <p class="px-4 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide">
          {{ selectedGroup ?? 'Sélectionner une catégorie' }}
        </p>
        <template v-if="selectedGroup">
          <template v-for="{ name: serverName, tools } in toolsInGroup" :key="serverName">
            <p class="px-4 py-1 text-xs text-gray-400 dark:text-gray-500 font-medium">
              {{ serverName.replace('mcp-', '') }}
            </p>
            <button
              v-for="tool in tools"
              :key="tool.name"
              class="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              @click="select(tool)"
            >
              <p class="font-medium text-gray-800 dark:text-gray-200">{{ tool.name }}</p>
              <p v-if="tool.description" class="text-xs text-gray-400 truncate mt-0.5">{{ tool.description }}</p>
            </button>
          </template>
          <p v-if="toolsInGroup.length === 0" class="px-4 py-4 text-sm text-gray-400">
            Aucun outil dans cette catégorie
          </p>
        </template>
      </div>
    </div>
  </UModal>
</template>

<script setup lang="ts">
interface Tool {
  serverName: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [boolean]
  'select': [Tool]
}>()

const { $api } = useNuxtApp()

const isOpen = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const { data: tools } = await useAsyncData<Tool[]>(
  'tools-picker',
  () => $api('/api/orch/tools'),
  { default: () => [] },
)

// Group tools by serverName first, then apply MCP group categories
const serverList = computed(() => {
  const byServer: Record<string, Tool[]> = {}
  for (const tool of tools.value ?? []) {
    if (!byServer[tool.serverName]) byServer[tool.serverName] = []
    byServer[tool.serverName].push(tool)
  }
  return Object.keys(byServer).map((name) => ({ name, tools: byServer[name] }))
})

const groupedServers = computed(() => groupServers(serverList.value))

const selectedGroup = ref<string | null>(null)

// Auto-select first group when data loads
watch(groupedServers, (groups) => {
  if (!selectedGroup.value && groups.length) selectedGroup.value = groups[0].group
}, { immediate: true })

const toolsInGroup = computed(() => {
  if (!selectedGroup.value) return []
  return groupedServers.value.find((g) => g.group === selectedGroup.value)?.items ?? []
})

function select(tool: Tool) {
  emit('select', tool)
  isOpen.value = false
}
</script>
