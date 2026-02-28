<template>
  <div class="py-6 flex gap-4" style="height: calc(100vh - 100px)">
    <!-- Left: Tool list sidebar -->
    <div class="w-60 flex-shrink-0 overflow-y-auto space-y-3 pr-1">
      <div v-if="toolsPending" class="flex justify-center pt-10">
        <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
      </div>

      <template v-else>
        <div v-for="(tools, server) in groupedTools" :key="server">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide px-2 mb-1">
            {{ String(server).replace('mcp-', '') }}
          </p>
          <div class="space-y-0.5">
            <button
              v-for="tool in tools"
              :key="tool.name"
              class="w-full text-left px-3 py-2 rounded-md text-sm transition"
              :class="
                selectedTool?.name === tool.name
                  ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400 font-medium'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              "
              @click="selectTool(tool)"
            >
              {{ tool.name }}
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- Right: Tool form -->
    <div class="flex-1 overflow-y-auto">
      <!-- Placeholder when nothing is selected -->
      <div
        v-if="!selectedTool"
        class="h-full flex flex-col items-center justify-center text-gray-400 gap-3"
      >
        <UIcon name="i-heroicons-cursor-arrow-rays" class="text-5xl" />
        <p class="text-sm">Select a tool to test it</p>
      </div>

      <UCard v-else>
        <template #header>
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-base font-semibold">{{ selectedTool.name }}</h2>
              <UBadge color="gray" variant="subtle" size="xs" :label="selectedTool.serverName.replace('mcp-', '')" />
            </div>
            <p v-if="selectedTool.description" class="text-sm text-gray-500 mt-1">
              {{ selectedTool.description }}
            </p>
          </div>
        </template>

        <!-- Form -->
        <form class="space-y-4" @submit.prevent="callTool">
          <div v-if="Object.keys(fields).length === 0" class="text-sm text-gray-400 italic">
            This tool takes no parameters.
          </div>

          <template v-for="(schema, fieldName) in fields" :key="fieldName">
            <UFormGroup
              :label="String(fieldName)"
              :required="isRequired(String(fieldName))"
              :description="schema.description"
            >
              <!-- Enum → select -->
              <USelect
                v-if="schema.enum"
                v-model="formValues[fieldName]"
                :options="schema.enum.map((v: string) => ({ label: v, value: v }))"
              />

              <!-- Boolean → toggle -->
              <UToggle
                v-else-if="schema.type === 'boolean'"
                v-model="formValues[fieldName]"
              />

              <!-- Number/integer → number input -->
              <UInput
                v-else-if="schema.type === 'number' || schema.type === 'integer'"
                v-model="formValues[fieldName]"
                type="number"
                :placeholder="String(fieldName)"
              />

              <!-- Array/object → JSON textarea -->
              <div v-else-if="schema.type === 'array' || schema.type === 'object'">
                <UTextarea
                  v-model="formValues[fieldName]"
                  :placeholder="`JSON ${schema.type}…`"
                  :rows="3"
                  :ui="{ base: 'font-mono text-xs' }"
                />
                <p class="text-xs text-gray-400 mt-1">Enter valid JSON</p>
              </div>

              <!-- Default → text input -->
              <UInput
                v-else
                v-model="formValues[fieldName]"
                :placeholder="schema.default !== undefined ? String(schema.default) : String(fieldName)"
              />
            </UFormGroup>
          </template>

          <div class="flex gap-2 pt-2">
            <UButton type="submit" :loading="callLoading" icon="i-heroicons-play">
              Call tool
            </UButton>
            <UButton
              type="button"
              variant="ghost"
              color="gray"
              icon="i-heroicons-arrow-path"
              @click="resetForm"
            >
              Reset
            </UButton>
          </div>
        </form>

        <!-- Result -->
        <template v-if="callResult !== undefined || callError">
          <UDivider class="my-4" />

          <UAlert
            v-if="callError"
            icon="i-heroicons-exclamation-triangle"
            color="red"
            :description="callError"
            class="mb-3"
          />

          <div v-if="callResult !== undefined">
            <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Result</p>
            <pre class="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 text-xs overflow-auto max-h-96">{{ JSON.stringify(callResult, null, 2) }}</pre>
          </div>
        </template>
      </UCard>
    </div>
  </div>
</template>

<script setup lang="ts">
interface ToolDef {
  serverName: string
  name: string
  description: string
  inputSchema: {
    properties?: Record<string, FieldSchema>
    required?: string[]
  }
}

interface FieldSchema {
  type?: string
  description?: string
  enum?: string[]
  default?: unknown
}

// ── Tools list ────────────────────────────────────────────────────────────────
const { data: toolsList, pending: toolsPending } = await useAsyncData<ToolDef[]>(
  'tools',
  () => $fetch('/api/tools'),
  { default: () => [] },
)

const groupedTools = computed(() => {
  const groups: Record<string, ToolDef[]> = {}
  for (const tool of toolsList.value ?? []) {
    if (!groups[tool.serverName]) groups[tool.serverName] = []
    groups[tool.serverName].push(tool)
  }
  return groups
})

// ── Selected tool ─────────────────────────────────────────────────────────────
const selectedTool = ref<ToolDef | null>(null)
const formValues = ref<Record<string, unknown>>({})
const callLoading = ref(false)
const callResult = ref<unknown>(undefined)
const callError = ref<string | null>(null)

const fields = computed<Record<string, FieldSchema>>(() => {
  return (selectedTool.value?.inputSchema?.properties as Record<string, FieldSchema>) ?? {}
})

function isRequired(fieldName: string): boolean {
  return (selectedTool.value?.inputSchema?.required ?? []).includes(fieldName)
}

function selectTool(tool: ToolDef) {
  selectedTool.value = tool
  callResult.value = undefined
  callError.value = null
  resetForm()
}

function resetForm() {
  const props = (selectedTool.value?.inputSchema?.properties as Record<string, FieldSchema>) ?? {}
  const values: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(props)) {
    if (schema.default !== undefined) {
      values[key] = schema.type === 'array' || schema.type === 'object'
        ? JSON.stringify(schema.default, null, 2)
        : schema.default
    } else if (schema.type === 'boolean') {
      values[key] = false
    } else {
      values[key] = ''
    }
  }
  formValues.value = values
}

// ── Call tool ─────────────────────────────────────────────────────────────────
async function callTool() {
  if (!selectedTool.value) return
  callLoading.value = true
  callResult.value = undefined
  callError.value = null

  try {
    const args: Record<string, unknown> = {}
    const props = (selectedTool.value.inputSchema?.properties as Record<string, FieldSchema>) ?? {}

    for (const [key, schema] of Object.entries(props)) {
      const val = formValues.value[key]
      if (val === '' || val === null || val === undefined) continue

      if (schema.type === 'number' || schema.type === 'integer') {
        args[key] = Number(val)
      } else if (schema.type === 'boolean') {
        args[key] = Boolean(val)
      } else if (schema.type === 'array' || schema.type === 'object') {
        args[key] = JSON.parse(val as string)
      } else {
        args[key] = val
      }
    }

    const data = await $fetch<{ result: unknown }>(`/api/tools/${selectedTool.value.name}`, {
      method: 'POST',
      body: args,
    })
    callResult.value = data.result
  } catch (e: unknown) {
    const err = e as { data?: { error?: string }; message?: string }
    callError.value = err?.data?.error ?? err?.message ?? 'Unknown error'
  } finally {
    callLoading.value = false
  }
}
</script>
