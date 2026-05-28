<template>
  <div class="py-6 space-y-6 max-w-3xl mx-auto">
    <!-- Loading -->
    <div v-if="loading" class="flex justify-center py-16">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-3xl" />
    </div>

    <template v-else>
      <!-- Header -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <UButton icon="i-heroicons-arrow-left" variant="ghost" color="gray" to="/scenes" />
          <h1 class="text-2xl font-bold">{{ isNew ? 'Nouvelle scène' : (form.name || 'Scène') }}</h1>
          <UBadge v-if="isBuiltIn" color="gray" variant="subtle" label="built-in" />
        </div>
        <div v-if="!isBuiltIn" class="flex gap-2">
          <UButton variant="ghost" color="gray" to="/scenes">Annuler</UButton>
          <UButton :loading="saving" @click="save">Enregistrer</UButton>
        </div>
        <div v-else>
          <UButton variant="ghost" color="gray" to="/scenes">Retour</UButton>
        </div>
      </div>

      <!-- Built-in read-only notice -->
      <UAlert
        v-if="isBuiltIn"
        color="yellow"
        variant="subtle"
        icon="i-heroicons-lock-closed"
        title="Scène intégrée"
        description="Cette scène est intégrée et ne peut pas être modifiée."
      />

      <!-- Meta form -->
      <div class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5 space-y-4">
        <UFormGroup label="Nom">
          <UInput v-model="form.name" :disabled="isBuiltIn" placeholder="Ma scène" />
        </UFormGroup>
        <div class="grid grid-cols-2 gap-4">
          <UFormGroup label="Icône">
            <UInput v-model="form.icon" :disabled="isBuiltIn" placeholder="lucide:bolt" />
          </UFormGroup>
          <UFormGroup label="Couleur">
            <div class="flex items-center gap-3">
              <input
                type="color"
                v-model="form.color"
                :disabled="isBuiltIn"
                class="w-10 h-9 rounded cursor-pointer border border-gray-300 dark:border-gray-600 bg-transparent"
              />
              <UInput v-model="form.color" :disabled="isBuiltIn" class="flex-1 font-mono text-xs" />
            </div>
          </UFormGroup>
        </div>
        <UFormGroup label="Description">
          <UTextarea v-model="form.description" :disabled="isBuiltIn" :rows="2" />
        </UFormGroup>
      </div>

      <!-- Setup actions -->
      <SceneActionList v-model="form.setup" label="Setup" :disabled="isBuiltIn" />

      <!-- State actions -->
      <SceneActionList v-model="form.state" label="État" :disabled="isBuiltIn" />
    </template>
  </div>
</template>

<script setup lang="ts">
interface SceneAction {
  tool: string
  args: Record<string, unknown>
  delayMs?: number
  _schema?: Record<string, unknown>
}

interface SceneForm {
  name: string
  icon: string
  color: string
  description: string
  setup: SceneAction[]
  state: SceneAction[]
  favorite?: boolean
}

const route = useRoute()
const router = useRouter()
const { $api } = useNuxtApp()
const toast = useToast()

const id = route.params.id as string
const isNew = id === 'new'

const loading = ref(!isNew)
const saving = ref(false)
const isBuiltIn = ref(false)

const form = reactive<SceneForm>({
  name: '',
  icon: 'lucide:bolt',
  color: '#6366f1',
  description: '',
  setup: [],
  state: [],
})

// Attach inputSchema from tools list to each action as _schema
function attachSchemas(actions: SceneAction[], tools: any[]): SceneAction[] {
  return actions.map((a) => {
    const tool = tools.find((t: any) => t.name === a.tool)
    return tool ? { ...a, _schema: tool.inputSchema } : { ...a }
  })
}

// Load existing scene
if (!isNew) {
  const [{ data }, { data: toolsData }] = await Promise.all([
    useAsyncData(`scene-${id}`, () =>
      ($api as any)('/api/orch/scenes').then((scenes: any[]) =>
        scenes.find((s: any) => s.id === id) ?? null,
      ),
    ),
    useAsyncData('tools-scene-editor', () => ($api as any)('/api/orch/tools')),
  ])
  if (data.value) {
    const tools = toolsData.value ?? []
    Object.assign(form, {
      name: data.value.name,
      icon: data.value.icon,
      color: data.value.color,
      description: data.value.description,
      setup: attachSchemas(data.value.setup ?? [], tools),
      state: attachSchemas(data.value.state ?? [], tools),
      favorite: data.value.favorite,
    })
    isBuiltIn.value = !!(data.value as any).builtIn
  } else {
    toast.add({ title: 'Scène introuvable', color: 'red' })
    await router.push('/scenes')
  }
  loading.value = false
}

// Strip _schema before sending to API
function cleanActions(actions: SceneAction[]) {
  return actions.map(({ _schema: _s, ...rest }) => rest)
}

async function save() {
  if (!form.name.trim()) {
    toast.add({ title: 'Le nom est requis', color: 'red' })
    return
  }
  saving.value = true
  try {
    const payload = {
      name: form.name,
      icon: form.icon,
      color: form.color,
      description: form.description,
      setup: cleanActions(form.setup),
      state: cleanActions(form.state),
      favorite: form.favorite ?? false,
    }
    if (isNew) {
      await $api('/api/orch/scenes', { method: 'POST', body: payload })
      toast.add({ title: 'Scène créée', color: 'green' })
    } else {
      await $api(`/api/orch/scenes/${id}`, { method: 'PATCH', body: payload })
      toast.add({ title: 'Scène enregistrée', color: 'green' })
    }
    await refreshNuxtData('scenes')
    router.push('/scenes')
  } catch (e: any) {
    toast.add({ title: 'Erreur', description: e?.data?.error ?? String(e), color: 'red' })
  } finally {
    saving.value = false
  }
}
</script>
