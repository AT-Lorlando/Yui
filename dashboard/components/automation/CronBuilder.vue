<template>
  <div class="space-y-3">
    <!-- Minute -->
    <div class="flex items-center gap-4">
      <label class="w-28 text-sm text-gray-600 dark:text-gray-400 shrink-0">Minute</label>
      <USelect v-model="fields.minute" :options="minuteOptions" size="sm" class="w-24" />
    </div>
    <!-- Heure -->
    <div class="flex items-center gap-4">
      <label class="w-28 text-sm text-gray-600 dark:text-gray-400 shrink-0">Heure</label>
      <USelect v-model="fields.hour" :options="hourOptions" size="sm" class="w-24" />
    </div>
    <!-- Jour du mois -->
    <div class="flex items-center gap-4">
      <label class="w-28 text-sm text-gray-600 dark:text-gray-400 shrink-0">Jour du mois</label>
      <USelect v-model="fields.dom" :options="domOptions" size="sm" class="w-24" />
    </div>
    <!-- Mois -->
    <div class="flex items-center gap-4">
      <label class="w-28 text-sm text-gray-600 dark:text-gray-400 shrink-0">Mois</label>
      <USelect v-model="fields.month" :options="monthOptions" size="sm" class="w-24" />
    </div>
    <!-- Jour de semaine -->
    <div class="flex items-start gap-4">
      <label class="w-28 text-sm text-gray-600 dark:text-gray-400 shrink-0 pt-1">Jour semaine</label>
      <div class="flex flex-wrap gap-2">
        <label
          v-for="day in DAYS"
          :key="day.value"
          class="flex items-center gap-1.5 cursor-pointer select-none"
        >
          <input
            type="checkbox"
            :value="day.value"
            v-model="selectedDays"
            class="rounded border-gray-300 dark:border-gray-600"
          />
          <span class="text-sm text-gray-700 dark:text-gray-300">{{ day.label }}</span>
        </label>
      </div>
    </div>

    <!-- Live preview -->
    <div class="flex items-center gap-2 pt-1">
      <span class="text-xs text-gray-400">Expression :</span>
      <code class="text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded font-mono">{{ expression }}</code>
    </div>
  </div>
</template>

<script setup lang="ts">
const DAYS = [
  { label: 'Dim', value: 0 },
  { label: 'Lun', value: 1 },
  { label: 'Mar', value: 2 },
  { label: 'Mer', value: 3 },
  { label: 'Jeu', value: 4 },
  { label: 'Ven', value: 5 },
  { label: 'Sam', value: 6 },
]

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [string]
}>()

// Build select options
function rangeOptions(from: number, to: number) {
  return [
    { label: '*', value: '*' },
    ...Array.from({ length: to - from + 1 }, (_, i) => ({
      label: String(from + i),
      value: String(from + i),
    })),
  ]
}

const minuteOptions = rangeOptions(0, 59)
const hourOptions   = rangeOptions(0, 23)
const domOptions    = rangeOptions(1, 31)
const monthOptions  = rangeOptions(1, 12)

// Parse incoming cron expression into fields
function parseCron(expr: string) {
  const parts = (expr || '* * * * *').split(' ')
  const parse = (s: string) => (s && /^\d+$/.test(s) ? s : '*')
  const parseDow = (s: string): number[] => {
    if (!s || s === '*') return DAYS.map((d) => d.value)
    return s.split(',').map(Number).filter((n) => !isNaN(n) && n >= 0 && n <= 6)
  }
  return {
    minute: parse(parts[0]),
    hour:   parse(parts[1]),
    dom:    parse(parts[2]),
    month:  parse(parts[3]),
    dow:    parseDow(parts[4]),
  }
}

const parsed = parseCron(props.modelValue)
const fields = reactive({
  minute: parsed.minute,
  hour:   parsed.hour,
  dom:    parsed.dom,
  month:  parsed.month,
})
const selectedDays = ref<number[]>(parsed.dow)

// Compose expression from fields
const expression = computed(() => {
  const dow =
    selectedDays.value.length === 0 || selectedDays.value.length === 7
      ? '*'
      : [...selectedDays.value].sort((a, b) => a - b).join(',')
  return `${fields.minute} ${fields.hour} ${fields.dom} ${fields.month} ${dow}`
})

// Emit when expression changes
watch(expression, (v) => emit('update:modelValue', v))

// Sync if parent changes the value externally
watch(() => props.modelValue, (v) => {
  const p = parseCron(v)
  fields.minute = p.minute
  fields.hour   = p.hour
  fields.dom    = p.dom
  fields.month  = p.month
  selectedDays.value = p.dow
})
</script>
