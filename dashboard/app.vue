<template>
  <div class="flex h-screen bg-gray-50 dark:bg-gray-900">
    <!-- Mobile overlay -->
    <Transition name="fade">
      <div
        v-if="mobileMenuOpen"
        class="fixed inset-0 bg-black/40 z-20 md:hidden"
        @click="mobileMenuOpen = false"
      />
    </Transition>

    <!-- ── Sidebar ──────────────────────────────────────────────────────── -->
    <aside
      class="fixed inset-y-0 left-0 z-30 w-56 flex flex-col
             bg-white dark:bg-gray-900
             border-r border-gray-200 dark:border-gray-800
             overflow-y-auto
             transform transition-transform duration-200 ease-in-out
             md:relative md:translate-x-0 md:z-auto md:flex-shrink-0"
      :class="mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'"
    >
      <!-- Logo -->
      <div class="px-5 py-5 flex items-center justify-between">
        <span class="font-bold text-xl tracking-tight">Yui</span>
        <button
          class="md:hidden p-1 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          @click="mobileMenuOpen = false"
        >
          <UIcon name="i-heroicons-x-mark" class="text-lg" />
        </button>
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
      <!-- Mobile header -->
      <div class="md:hidden sticky top-0 z-10 flex items-center px-4 py-3
                  bg-white/80 dark:bg-gray-900/80 backdrop-blur
                  border-b border-gray-200 dark:border-gray-800">
        <button
          class="p-1.5 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          @click="mobileMenuOpen = true"
        >
          <UIcon name="i-heroicons-bars-3" class="text-xl" />
        </button>
        <span class="ml-3 font-bold text-lg">Yui</span>
      </div>

      <div class="px-4 md:px-6 max-w-6xl mx-auto">
        <NuxtPage />
      </div>
    </main>
  </div>

  <UNotifications />
</template>

<script setup lang="ts">
const colorMode = useColorMode()
const route = useRoute()
const mobileMenuOpen = ref(false)

watch(() => route.path, () => { mobileMenuOpen.value = false })

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

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
