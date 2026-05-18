<template>
  <div class="py-6 space-y-6 max-w-2xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <UButton icon="i-heroicons-arrow-left" variant="ghost" color="gray" to="/schedules" />
        <h1 class="text-2xl font-bold">{{ isNew ? 'Nouvelle automation' : (form.name || 'Automation') }}</h1>
      </div>
      <div class="flex gap-2">
        <UButton variant="ghost" color="gray" to="/schedules">Annuler</UButton>
        <UButton :loading="saving" @click="save">Enregistrer</UButton>
      </div>
    </div>

    <!-- Nom -->
    <div class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5">
      <UFormGroup label="Nom">
        <UInput v-model="form.name" placeholder="Mon automation" />
      </UFormGroup>
    </div>

    <!-- Déclencheur -->
    <div class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5 space-y-4">
      <h2 class="font-semibold text-sm">Déclencheur</h2>
      <!-- Type selector -->
      <div class="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden w-fit">
        <button
          v-for="type in triggerTypes"
          :key="type.value"
          class="px-4 py-2 text-sm transition-colors"
          :class="triggerType === type.value
            ? 'bg-primary-500 dark:bg-primary-600 text-white'
            : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'"
          @click="triggerType = type.value"
        >
          {{ type.label }}
        </button>
      </div>

      <!-- Cron builder -->
      <CronBuilder v-if="triggerType === 'cron'" v-model="cronExpr" />

      <!-- Delay input -->
      <div v-else class="flex items-center gap-3">
        <UFormGroup label="Dans" class="flex-1">
          <UInput v-model.number="delayMinutes" type="number" min="1" placeholder="30" />
        </UFormGroup>
        <span class="text-sm text-gray-500 mt-5">minutes</span>
      </div>
    </div>

    <!-- Action -->
    <div class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5 space-y-4">
      <h2 class="font-semibold text-sm">Action</h2>
      <!-- Type selector -->
      <div class="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden w-fit">
        <button
          v-for="type in actionTypes"
          :key="type.value"
          class="px-4 py-2 text-sm transition-colors"
          :class="actionType === type.value
            ? 'bg-primary-500 dark:bg-primary-600 text-white'
            : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'"
          @click="actionType = type.value"
        >
          {{ type.label }}
        </button>
      </div>

      <!-- Scene picker -->
      <UFormGroup v-if="actionType === 'scene'" label="Scène">
        <USelect
          v-model="sceneId"
          :options="sceneOptions"
          placeholder="Choisir une scène"
        />
      </UFormGroup>

      <!-- Prompt -->
      <template v-else>
        <UFormGroup label="Texte">
          <UTextarea v-model="promptText" placeholder="Rappelle-moi de…" :rows="3" />
        </UFormGroup>
        <UFormGroup label="Sortie">
          <USelect v-model="promptOutput" :options="outputOptions" />
        </UFormGroup>
      </template>
    </div>

    <!-- Activée -->
    <div class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5">
      <div class="flex items-center justify-between">
        <div>
          <p class="font-semibold text-sm">Activée</p>
          <p class="text-xs text-gray-400 mt-0.5">L'automation se déclenchera automatiquement si activée</p>
        </div>
        <UToggle v-model="form.enabled" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Scene {
  id: string
  name: string
}

const route = useRoute()
const router = useRouter()
const { $api } = useNuxtApp()
const toast = useToast()

const id = route.params.id as string
const isNew = id === 'new'

const saving = ref(false)

const form = reactive({
  name: '',
  enabled: true,
})

const triggerType = ref<'cron' | 'delay'>('cron')
const cronExpr = ref('0 9 * * 1-5')
const delayMinutes = ref(30)

const actionType = ref<'scene' | 'prompt'>('scene')
const sceneId = ref('')
const promptText = ref('')
const promptOutput = ref<'cast' | 'notify' | 'none'>('cast')

const triggerTypes = [
  { label: 'Cron', value: 'cron' },
  { label: 'Minuteur', value: 'delay' },
]
const actionTypes = [
  { label: 'Scène', value: 'scene' },
  { label: 'Prompt', value: 'prompt' },
]
const outputOptions = [
  { label: 'Vocal (Salon)', value: 'cast' },
  { label: 'Notification', value: 'notify' },
  { label: 'Aucune', value: 'none' },
]

// Load scenes for scene picker
const { data: scenes } = await useAsyncData<Scene[]>(
  'scenes-for-automation',
  () => $api('/api/orch/scenes'),
  { default: () => [] },
)

const sceneOptions = computed(() =>
  (scenes.value ?? []).map((s) => ({ label: s.name, value: s.id })),
)

// Load existing automation when editing
if (!isNew) {
  const { data } = await useAsyncData(`automation-${id}`, () =>
    $api<any[]>('/api/orch/automations').then((list) =>
      list.find((a) => a.id === id) ?? null,
    ),
  )
  if (data.value) {
    const a = data.value
    form.name = a.name
    form.enabled = a.enabled

    if (a.trigger.type === 'cron') {
      triggerType.value = 'cron'
      cronExpr.value = a.trigger.expr ?? '* * * * *'
    } else {
      triggerType.value = 'delay'
      delayMinutes.value = Math.round((a.trigger.ms ?? 60000) / 60000)
    }

    if (a.action.type === 'scene') {
      actionType.value = 'scene'
      sceneId.value = a.action.sceneId ?? ''
    } else {
      actionType.value = 'prompt'
      promptText.value = a.action.text ?? ''
      promptOutput.value = a.action.output ?? 'cast'
    }
  } else {
    toast.add({ title: 'Automation introuvable', color: 'red' })
    await router.push('/schedules')
  }
}

function buildPayload() {
  const trigger =
    triggerType.value === 'cron'
      ? { type: 'cron' as const, expr: cronExpr.value }
      : { type: 'delay' as const, ms: delayMinutes.value * 60000 }

  const action =
    actionType.value === 'scene'
      ? { type: 'scene' as const, sceneId: sceneId.value }
      : { type: 'prompt' as const, text: promptText.value, output: promptOutput.value }

  return {
    name: form.name,
    enabled: form.enabled,
    trigger,
    action,
    notify: null,
  }
}

async function save() {
  if (!form.name.trim()) {
    toast.add({ title: 'Le nom est requis', color: 'red' })
    return
  }
  if (actionType.value === 'scene' && !sceneId.value) {
    toast.add({ title: 'Sélectionner une scène', color: 'red' })
    return
  }
  if (actionType.value === 'prompt' && !promptText.value.trim()) {
    toast.add({ title: 'Le texte du prompt est requis', color: 'red' })
    return
  }

  saving.value = true
  try {
    const payload = buildPayload()
    if (isNew) {
      await $api('/api/orch/automations', { method: 'POST', body: payload })
      toast.add({ title: 'Automation créée', color: 'green' })
    } else {
      await $api(`/api/orch/automations/${id}`, { method: 'PATCH', body: payload })
      toast.add({ title: 'Automation enregistrée', color: 'green' })
    }
    router.push('/schedules')
  } catch (e: any) {
    toast.add({ title: 'Erreur', description: e?.data?.error ?? String(e), color: 'red' })
  } finally {
    saving.value = false
  }
}
</script>
