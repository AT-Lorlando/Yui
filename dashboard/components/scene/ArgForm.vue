<template>
  <div class="space-y-3">
    <template v-for="[key, prop] in schemaProperties" :key="key">
      <div class="flex items-center gap-3">
        <label class="w-32 text-xs text-gray-500 dark:text-gray-400 shrink-0">
          {{ key }}<span v-if="isRequired(key)" class="text-red-400 ml-0.5">*</span>
        </label>
        <!-- boolean → toggle -->
        <UToggle
          v-if="prop.type === 'boolean'"
          :model-value="!!args[key]"
          @update:model-value="update(key, $event)"
        />
        <!-- enum → select -->
        <USelect
          v-else-if="prop.enum"
          :model-value="args[key] ?? ''"
          :options="(prop.enum as string[])"
          @update:model-value="update(key, $event)"
          size="sm"
          class="flex-1"
        />
        <!-- number → number input -->
        <UInput
          v-else-if="prop.type === 'number' || prop.type === 'integer'"
          type="number"
          :model-value="args[key] ?? ''"
          @update:model-value="update(key, $event === '' ? undefined : Number($event))"
          size="sm"
          class="flex-1"
        />
        <!-- string / fallback → text input -->
        <UInput
          v-else
          :model-value="String(args[key] ?? '')"
          @update:model-value="update(key, $event)"
          size="sm"
          class="flex-1"
          :placeholder="prop.description ?? ''"
        />
      </div>
    </template>

    <!-- delayMs field -->
    <div class="flex items-center gap-3">
      <label class="w-32 text-xs text-gray-500 dark:text-gray-400 shrink-0">
        délai (ms)
      </label>
      <UInput
        type="number"
        :model-value="localDelayMs ?? ''"
        @update:model-value="updateDelay($event)"
        size="sm"
        class="flex-1"
        placeholder="0"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
interface SchemaProp {
  type?: string
  description?: string
  enum?: unknown[]
}

interface JSONSchema {
  type?: string
  properties?: Record<string, SchemaProp>
  required?: string[]
}

const props = defineProps<{
  schema: JSONSchema
  args: Record<string, unknown>
  delayMs?: number
}>()

const emit = defineEmits<{
  'update:args': [Record<string, unknown>]
  'update:delayMs': [number | undefined]
}>()

const localDelayMs = ref(props.delayMs)
watch(() => props.delayMs, (v) => { localDelayMs.value = v })

const schemaProperties = computed(() =>
  Object.entries(props.schema?.properties ?? {}) as [string, SchemaProp][]
)

function isRequired(key: string): boolean {
  return (props.schema?.required ?? []).includes(key)
}

function update(key: string, value: unknown) {
  emit('update:args', { ...props.args, [key]: value })
}

function updateDelay(raw: string | number) {
  const v = raw === '' ? undefined : Number(raw)
  localDelayMs.value = v
  emit('update:delayMs', v)
}
</script>
