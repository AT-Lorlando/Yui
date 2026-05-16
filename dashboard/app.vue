<template>
  <div class="flex h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
    <!-- ── Sidebar ──────────────────────────────────────────────────────── -->
    <aside
      class="w-56 flex-shrink-0 flex flex-col sticky top-0 h-screen
             bg-white dark:bg-gray-900
             border-r border-gray-200 dark:border-gray-800
             overflow-y-auto"
    >
      <!-- Logo -->
      <div class="px-5 py-5">
        <span class="font-bold text-xl tracking-tight">Yui</span>
      </div>

      <!-- Nav -->
      <nav class="flex-1 px-3 space-y-0.5">
        <NuxtLink to="/" :class="linkClass('/', true)">
          <UIcon name="i-heroicons-home" class="text-lg shrink-0" />
          <span>Status</span>
        </NuxtLink>
        <NuxtLink to="/tools" :class="linkClass('/tools')">
          <UIcon name="i-heroicons-wrench-screwdriver" class="text-lg shrink-0" />
          <span>MCP Tools</span>
        </NuxtLink>

        <div class="my-2 border-t border-gray-100 dark:border-gray-800" />

        <NuxtLink to="/scenes" :class="linkClass('/scenes')">
          <UIcon name="i-heroicons-bolt" class="text-lg shrink-0" />
          <span>Scènes</span>
        </NuxtLink>
        <NuxtLink to="/schedules" :class="linkClass('/schedules')">
          <UIcon name="i-heroicons-clock" class="text-lg shrink-0" />
          <span>Automations</span>
        </NuxtLink>
        <NuxtLink to="/timers" :class="linkClass('/timers')">
          <UIcon name="i-heroicons-bell-alert" class="text-lg shrink-0" />
          <span>Timers</span>
        </NuxtLink>

        <div class="my-2 border-t border-gray-100 dark:border-gray-800" />

        <NuxtLink to="/memory" :class="linkClass('/memory')">
          <UIcon name="i-heroicons-book-open" class="text-lg shrink-0" />
          <span>Mémoire</span>
        </NuxtLink>
        <NuxtLink to="/presence" :class="linkClass('/presence')">
          <UIcon name="i-heroicons-map-pin" class="text-lg shrink-0" />
          <span>Présence</span>
        </NuxtLink>
        <NuxtLink to="/prompts" :class="linkClass('/prompts')">
          <UIcon name="i-heroicons-document-text" class="text-lg shrink-0" />
          <span>Prompts</span>
        </NuxtLink>
      </nav>

      <!-- Dark mode toggle -->
      <div class="px-3 py-4 border-t border-gray-100 dark:border-gray-800">
        <button
          class="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm
                 text-gray-600 dark:text-gray-400
                 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          @click="toggleColorMode"
        >
          <UIcon
            :name="colorMode.value === 'dark' ? 'i-heroicons-sun' : 'i-heroicons-moon'"
            class="text-lg shrink-0"
          />
          <span>{{ colorMode.value === 'dark' ? 'Mode clair' : 'Mode sombre' }}</span>
        </button>
      </div>
    </aside>

    <!-- ── Main content ───────────────────────────────────────────────── -->
    <main class="flex-1 min-w-0 overflow-y-auto">
      <div class="px-6 max-w-6xl mx-auto">
        <NuxtPage />
      </div>
    </main>
  </div>

  <UNotifications />
</template>

<script setup lang="ts">
const colorMode = useColorMode()
const route = useRoute()

function toggleColorMode() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

function linkClass(path: string, exact = false): string[] {
  const active = exact ? route.path === path : route.path.startsWith(path)
  return [
    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
    active
      ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400 font-medium'
      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
  ]
}
</script>
