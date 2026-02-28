<template>
  <div class="py-6 space-y-6">
    <!-- Header -->
    <div class="flex items-center gap-3">
      <h1 class="text-2xl font-bold">Dashboard</h1>
      <UBadge
        :color="status?.online ? 'green' : 'red'"
        variant="subtle"
        :label="status?.online ? 'Orchestrator online' : 'Orchestrator offline'"
      />
    </div>

    <!-- MCP Servers -->
    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <h2 class="text-base font-semibold">MCP Servers</h2>
          <UBadge
            v-if="status?.online"
            color="gray"
            variant="subtle"
            :label="`${status.totalTools} tools total`"
          />
        </div>
      </template>

      <div v-if="statusPending" class="flex justify-center py-6">
        <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
      </div>

      <div v-else-if="!status?.online" class="text-center py-6 text-gray-400">
        <UIcon name="i-heroicons-signal-slash" class="text-4xl mb-2" />
        <p>Orchestrator not reachable</p>
      </div>

      <div v-else class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        <div
          v-for="server in status.servers"
          :key="server.name"
          class="bg-gray-50 dark:bg-gray-800 rounded-lg px-4 py-3 text-center"
        >
          <p class="text-xs text-gray-500 truncate">{{ server.name.replace('mcp-', '') }}</p>
          <p class="text-2xl font-bold text-primary-500 mt-1">{{ server.tools }}</p>
          <p class="text-xs text-gray-400">tools</p>
        </div>
      </div>
    </UCard>

    <!-- PM2 Processes -->
    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <h2 class="text-base font-semibold">PM2 Processes</h2>
          <UButton
            icon="i-heroicons-arrow-path"
            variant="ghost"
            color="gray"
            size="xs"
            :loading="pm2Pending"
            @click="refreshPm2"
          />
        </div>
      </template>

      <div v-if="pm2Pending && !pm2Data?.length" class="flex justify-center py-6">
        <UIcon name="i-heroicons-arrow-path" class="animate-spin text-gray-400 text-2xl" />
      </div>

      <div v-else-if="!pm2Data?.length" class="text-center py-4 text-sm text-gray-400">
        PM2 not running or no processes found
      </div>

      <UTable
        v-else
        :columns="pm2Columns"
        :rows="pm2Rows"
        :ui="{ td: { base: 'text-sm' } }"
      >
        <template #status-data="{ row }">
          <UBadge
            :color="statusColor(row.status)"
            variant="subtle"
            size="xs"
            :label="row.status"
          />
        </template>
        <template #memory-data="{ row }">
          {{ formatMemory(row.memoryRaw) }}
        </template>
        <template #cpu-data="{ row }">
          {{ row.cpu }}%
        </template>
      </UTable>
    </UCard>

    <!-- Order Tester -->
    <UCard>
      <template #header>
        <h2 class="text-base font-semibold">Send Order</h2>
      </template>

      <div class="space-y-3">
        <UTextarea
          v-model="orderText"
          placeholder="Allume les lumières du salon…"
          :rows="3"
          :disabled="orderLoading"
        />

        <div class="flex gap-2">
          <UButton
            :loading="orderLoading"
            :disabled="!orderText.trim()"
            icon="i-heroicons-paper-airplane"
            @click="sendOrder"
          >
            Send
          </UButton>
          <UButton
            variant="ghost"
            color="gray"
            :disabled="orderLoading"
            @click="orderText = ''; orderResult = null; orderError = null"
          >
            Clear
          </UButton>
        </div>

        <UAlert
          v-if="orderError"
          icon="i-heroicons-exclamation-triangle"
          color="red"
          :description="orderError"
        />

        <div v-if="orderResult !== null" class="rounded-lg bg-gray-50 dark:bg-gray-800 p-4">
          <p class="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">Response</p>
          <p class="text-sm whitespace-pre-wrap">{{ orderResult }}</p>
        </div>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
interface ServerStatus {
  online: boolean
  servers: { name: string; tools: number }[]
  totalTools: number
}

interface Pm2Process {
  name: string
  pid: number | null
  pm2_env: {
    status: string
    restart_time: number
    pm_uptime: number
  }
  monit: {
    memory: number
    cpu: number
  }
}

// ── Status ────────────────────────────────────────────────────────────────────
const { data: status, pending: statusPending, refresh: refreshStatus } = await useAsyncData<ServerStatus>(
  'status',
  () => $fetch('/api/status'),
)

// ── PM2 ───────────────────────────────────────────────────────────────────────
const { data: pm2Data, pending: pm2Pending, refresh: refreshPm2 } = await useAsyncData<Pm2Process[]>(
  'pm2',
  () => $fetch('/api/pm2'),
  { default: () => [] },
)

const pm2Columns = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'pid', label: 'PID' },
  { key: 'memory', label: 'Memory' },
  { key: 'cpu', label: 'CPU' },
  { key: 'restarts', label: 'Restarts' },
]

const pm2Rows = computed(() =>
  (pm2Data.value ?? []).map((p) => ({
    name: p.name,
    status: p.pm2_env?.status ?? 'unknown',
    pid: p.pid ?? '-',
    memoryRaw: p.monit?.memory ?? 0,
    cpu: p.monit?.cpu ?? 0,
    restarts: p.pm2_env?.restart_time ?? 0,
  })),
)

function statusColor(s: string): 'green' | 'red' | 'yellow' | 'gray' {
  if (s === 'online') return 'green'
  if (s === 'stopped') return 'gray'
  if (s === 'errored') return 'red'
  return 'yellow'
}

function formatMemory(bytes: number): string {
  if (!bytes) return '-'
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(0)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

// ── Auto-refresh ───────────────────────────────────────────────────────────────
onMounted(() => {
  const interval = setInterval(() => {
    refreshStatus()
    refreshPm2()
  }, 15_000)
  onUnmounted(() => clearInterval(interval))
})

// ── Order tester ──────────────────────────────────────────────────────────────
const orderText = ref('')
const orderResult = ref<string | null>(null)
const orderError = ref<string | null>(null)
const orderLoading = ref(false)

async function sendOrder() {
  if (!orderText.value.trim()) return
  orderLoading.value = true
  orderResult.value = null
  orderError.value = null

  try {
    const data = await $fetch<{ response: string }>('/api/order', {
      method: 'POST',
      body: { order: orderText.value },
    })
    orderResult.value = data.response
  } catch (e: unknown) {
    const err = e as { data?: { error?: string }; message?: string }
    orderError.value = err?.data?.error ?? err?.message ?? 'Unknown error'
  } finally {
    orderLoading.value = false
  }
}
</script>
