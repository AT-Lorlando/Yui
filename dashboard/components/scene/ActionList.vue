<template>
  <div class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 overflow-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
      <h3 class="font-semibold text-sm">{{ label }}</h3>
      <UBadge color="gray" variant="subtle" :label="`${localActions.length} action${localActions.length !== 1 ? 's' : ''}`" />
    </div>

    <!-- Action rows -->
    <div class="divide-y divide-gray-100 dark:divide-gray-700">
      <ClientOnly>
        <VueDraggable
          v-model="localActions"
          handle=".drag-handle"
          :animation="150"
          @end="onDragEnd"
        >
          <div v-for="(action, idx) in localActions" :key="idx">
            <!-- Summary row -->
            <div
              class="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
              @click="toggleExpand(idx)"
            >
              <span class="drag-handle cursor-grab text-gray-300 dark:text-gray-600 select-none text-lg leading-none" @click.stop>⠿</span>
              <div class="flex-1 min-w-0">
                <span class="font-mono text-xs font-medium text-gray-700 dark:text-gray-300">{{ action.tool }}</span>
                <span class="ml-2 text-xs text-gray-400">{{ argSummary(action.args) }}</span>
                <UBadge v-if="action.delayMs" color="yellow" variant="subtle" size="xs" :label="`${action.delayMs}ms`" class="ml-2" />
              </div>
              <div class="flex items-center gap-1">
                <UIcon
                  :name="expandedIndex === idx ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'"
                  class="text-gray-400 text-sm"
                />
                <UButton
                  v-if="!disabled"
                  size="xs"
                  variant="ghost"
                  color="red"
                  icon="i-heroicons-trash"
                  @click.stop="remove(idx)"
                />
              </div>
            </div>

            <!-- Expanded: ArgForm -->
            <div v-if="expandedIndex === idx" class="px-5 pb-4 bg-gray-50 dark:bg-gray-900/30">
              <ArgForm
                :schema="action._schema ?? {}"
                :args="action.args"
                :delay-ms="action.delayMs"
                @update:args="updateArgs(idx, $event)"
                @update:delay-ms="updateDelay(idx, $event)"
              />
            </div>
          </div>
        </VueDraggable>
        <template #fallback>
          <div v-for="(action, idx) in localActions" :key="idx" class="flex items-center gap-3 px-5 py-3">
            <span class="font-mono text-xs text-gray-700 dark:text-gray-300">{{ action.tool }}</span>
          </div>
        </template>
      </ClientOnly>
    </div>

    <!-- Empty state -->
    <div v-if="localActions.length === 0" class="px-5 py-6 text-center text-sm text-gray-400">
      Aucune action — ajoutez-en une ci-dessous
    </div>

    <!-- Add button -->
    <div v-if="!disabled" class="px-5 py-3 border-t border-gray-100 dark:border-gray-700">
      <UButton
        size="sm"
        variant="ghost"
        color="gray"
        icon="i-heroicons-plus"
        @click="pickerOpen = true"
      >
        Ajouter une action
      </UButton>
    </div>

    <!-- ToolPicker modal -->
    <ToolPicker v-model="pickerOpen" @select="addAction" />
  </div>
</template>

<script setup lang="ts">
import { VueDraggable } from 'vue-draggable-plus'

interface SceneAction {
  tool: string
  args: Record<string, unknown>
  delayMs?: number
  _schema?: Record<string, unknown>
}

const props = defineProps<{
  modelValue: SceneAction[]
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [SceneAction[]]
}>()

const pickerOpen = ref(false)
const expandedIndex = ref<number | null>(null)

// VueDraggable mutates the array in-place via SortableJS — use a local ref, not computed
const localActions = ref<SceneAction[]>([...props.modelValue])
watch(() => props.modelValue, (v) => { localActions.value = [...v] })

function onDragEnd() {
  emit('update:modelValue', [...localActions.value])
  expandedIndex.value = null
}

function toggleExpand(idx: number) {
  expandedIndex.value = expandedIndex.value === idx ? null : idx
}

function argSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      const display = Array.isArray(v) ? `[…]` : String(v).slice(0, 20)
      return `${k}=${display}`
    })
    .join(' ')
}

function addAction(tool: { name: string; inputSchema: Record<string, unknown> }) {
  const newAction: SceneAction = {
    tool: tool.name,
    args: {},
    _schema: tool.inputSchema,
  }
  localActions.value = [...localActions.value, newAction]
  emit('update:modelValue', localActions.value)
  expandedIndex.value = localActions.value.length - 1
}

function remove(idx: number) {
  localActions.value = localActions.value.filter((_, i) => i !== idx)
  emit('update:modelValue', localActions.value)
  if (expandedIndex.value === idx) expandedIndex.value = null
  else if (expandedIndex.value !== null && expandedIndex.value > idx) expandedIndex.value--
}

function updateArgs(idx: number, args: Record<string, unknown>) {
  localActions.value = localActions.value.map((a, i) => i === idx ? { ...a, args } : a)
  emit('update:modelValue', localActions.value)
}

function updateDelay(idx: number, delayMs: number | undefined) {
  localActions.value = localActions.value.map((a, i) => {
    if (i !== idx) return a
    const { delayMs: _old, ...rest } = a
    return delayMs !== undefined ? { ...rest, delayMs } : rest
  })
  emit('update:modelValue', localActions.value)
}
</script>
