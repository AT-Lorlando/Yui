<template>
  <div class="py-6 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Prompts</h1>
      <UBadge v-if="prompts?.length" color="gray" variant="subtle" :label="`${prompts.length} fichier${prompts.length > 1 ? 's' : ''}`" />
    </div>

    <div v-if="pending" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
    </div>

    <div v-else-if="!prompts?.length" class="text-center py-12 text-gray-400">
      <UIcon name="i-heroicons-document-text" class="text-5xl mb-3" />
      <p>Aucun fichier trouvé dans prompts/</p>
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="p in prompts"
        :key="p.file"
        class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 overflow-hidden"
      >
        <!-- File header -->
        <button
          class="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-750 transition"
          @click="toggle(p.file)"
        >
          <div class="flex items-center gap-3">
            <UIcon name="i-heroicons-document-text" class="text-primary-400 shrink-0" />
            <div>
              <p class="font-semibold text-sm capitalize">{{ p.name }}</p>
              <p class="text-xs text-gray-400 font-mono">{{ p.file }}</p>
            </div>
          </div>
          <UIcon
            :name="open[p.file] ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'"
            class="text-gray-400 shrink-0"
          />
        </button>

        <!-- Content -->
        <div v-if="open[p.file]" class="border-t border-gray-100 dark:border-gray-700 px-5 py-4">
          <pre class="text-xs font-mono text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{{ p.content }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface PromptFile {
  file: string
  name: string
  content: string
}

const { $api } = useNuxtApp()

const { data: prompts, pending } = await useAsyncData<PromptFile[]>(
  'prompts',
  () => $api('/api/orch/prompts'),
  { default: () => [] },
)

const open = ref<Record<string, boolean>>({})

function toggle(file: string) {
  open.value[file] = !open.value[file]
}
</script>
