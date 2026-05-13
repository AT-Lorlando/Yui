<template>
  <div class="py-6 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Scènes</h1>
      <UBadge v-if="scenes?.length" color="gray" variant="subtle" :label="`${scenes.length} scènes`" />
    </div>

    <div v-if="pending" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
    </div>

    <div v-else-if="error" class="text-center py-12 text-gray-400">
      <UIcon name="i-heroicons-signal-slash" class="text-4xl mb-2" />
      <p>Orchestrator non disponible</p>
    </div>

    <template v-else>
      <!-- Section Favoris (only if at least 1 favorite) -->
      <div v-if="favorites.length > 0" class="space-y-3">
        <h2 class="text-sm font-semibold text-yellow-500 uppercase tracking-wide flex items-center gap-1">
          <UIcon name="i-heroicons-star-solid" class="text-yellow-400" />
          Favoris
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          <div
            v-for="scene in favorites"
            :key="`fav-${scene.id}`"
            class="relative rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col"
          >
            <div class="h-1 w-full" :style="{ backgroundColor: scene.color }" />
            <div class="flex flex-col flex-1 p-4 gap-3">
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2">
                  <div
                    class="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm"
                    :style="{ backgroundColor: scene.color + '22', color: scene.color }"
                  >
                    <UIcon :name="iconName(scene.icon)" class="text-lg" />
                  </div>
                  <div>
                    <p class="font-semibold text-sm leading-tight">{{ scene.name }}</p>
                    <UBadge v-if="scene.builtIn" color="gray" variant="subtle" size="xs" label="built-in" class="mt-0.5" />
                  </div>
                </div>
                <button
                  class="shrink-0 p-1 rounded transition-colors text-yellow-400"
                  :disabled="favoriteLoading[scene.id]"
                  @click.stop="toggleFavorite(scene.id)"
                >
                  <UIcon name="i-heroicons-star-solid" class="text-lg" />
                </button>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 flex-1 leading-relaxed">{{ scene.description }}</p>
              <div class="flex gap-3 text-xs text-gray-400">
                <span>{{ scene.setup.length }} setup</span>
                <span>{{ scene.state.length }} actions</span>
              </div>
              <UButton
                size="sm"
                variant="soft"
                :color="triggerLoading[scene.id] ? 'gray' : 'primary'"
                :loading="triggerLoading[scene.id]"
                :icon="triggerDone[scene.id] ? 'i-heroicons-check' : 'i-heroicons-play'"
                class="w-full"
                @click="trigger(scene.id)"
              >
                {{ triggerDone[scene.id] ? 'Lancée !' : 'Déclencher' }}
              </UButton>
            </div>
          </div>
        </div>
      </div>

      <!-- Toutes les scènes -->
      <div class="space-y-3">
        <h2 v-if="favorites.length > 0" class="text-sm font-semibold text-gray-400 uppercase tracking-wide">
          Toutes les scènes
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          <div
            v-for="scene in scenes"
            :key="scene.id"
            class="relative rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col"
          >
            <div class="h-1 w-full" :style="{ backgroundColor: scene.color }" />
            <div class="flex flex-col flex-1 p-4 gap-3">
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2">
                  <div
                    class="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm"
                    :style="{ backgroundColor: scene.color + '22', color: scene.color }"
                  >
                    <UIcon :name="iconName(scene.icon)" class="text-lg" />
                  </div>
                  <div>
                    <p class="font-semibold text-sm leading-tight">{{ scene.name }}</p>
                    <UBadge v-if="scene.builtIn" color="gray" variant="subtle" size="xs" label="built-in" class="mt-0.5" />
                  </div>
                </div>
                <!-- Star button -->
                <button
                  class="shrink-0 p-1 rounded transition-colors"
                  :class="scene.favorite ? 'text-yellow-400' : 'text-gray-300 hover:text-yellow-300'"
                  :disabled="favoriteLoading[scene.id]"
                  @click.stop="toggleFavorite(scene.id)"
                >
                  <UIcon
                    :name="scene.favorite ? 'i-heroicons-star-solid' : 'i-heroicons-star'"
                    class="text-lg"
                  />
                </button>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 flex-1 leading-relaxed">{{ scene.description }}</p>
              <div class="flex gap-3 text-xs text-gray-400">
                <span>{{ scene.setup.length }} setup</span>
                <span>{{ scene.state.length }} actions</span>
              </div>
              <UButton
                size="sm"
                variant="soft"
                :color="triggerLoading[scene.id] ? 'gray' : 'primary'"
                :loading="triggerLoading[scene.id]"
                :icon="triggerDone[scene.id] ? 'i-heroicons-check' : 'i-heroicons-play'"
                class="w-full"
                @click="trigger(scene.id)"
              >
                {{ triggerDone[scene.id] ? 'Lancée !' : 'Déclencher' }}
              </UButton>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
interface SceneAction {
  tool: string
  args: Record<string, unknown>
  delayMs?: number
}

interface Scene {
  id: string
  name: string
  icon: string
  color: string
  description: string
  builtIn?: boolean
  favorite?: boolean
  setup: SceneAction[]
  state: SceneAction[]
  createdAt: number
}

const { $api } = useNuxtApp()
const toast = useToast()

const { data: scenes, pending, error } = await useAsyncData<Scene[]>(
  'scenes',
  () => $api('/api/orch/scenes'),
  { default: () => [] },
)

const triggerLoading = ref<Record<string, boolean>>({})
const triggerDone = ref<Record<string, boolean>>({})
const favoriteLoading = ref<Record<string, boolean>>({})

const favorites = computed(() =>
  (scenes.value ?? []).filter((s) => s.favorite)
)

function iconName(raw: string): string {
  if (!raw) return 'i-heroicons-bolt'
  // "lucide:clapperboard" → "i-lucide-clapperboard"
  if (raw.includes(':')) {
    const [set, name] = raw.split(':')
    return `i-${set}-${name}`
  }
  return `i-heroicons-${raw}`
}

async function trigger(id: string) {
  if (triggerLoading.value[id]) return
  triggerLoading.value[id] = true
  triggerDone.value[id] = false
  try {
    await $api(`/api/orch/scenes/${id}/trigger`, { method: 'POST' })
    triggerDone.value[id] = true
    setTimeout(() => { triggerDone.value[id] = false }, 3000)
  } catch (e: any) {
    toast.add({ title: 'Erreur', description: e?.data?.error ?? String(e), color: 'red' })
  } finally {
    triggerLoading.value[id] = false
  }
}

async function toggleFavorite(id: string) {
  if (favoriteLoading.value[id]) return
  favoriteLoading.value[id] = true
  const scene = scenes.value?.find((s) => s.id === id)
  if (scene) scene.favorite = !scene.favorite
  try {
    const { scene: updated } = await $api<{ scene: Scene }>(`/api/orch/scenes/${id}/favorite`, { method: 'PATCH' })
    if (scene) scene.favorite = updated.favorite
  } catch (e: any) {
    if (scene) scene.favorite = !scene.favorite
    toast.add({ title: 'Erreur', description: e?.data?.error ?? String(e), color: 'red' })
  } finally {
    favoriteLoading.value[id] = false
  }
}
</script>
