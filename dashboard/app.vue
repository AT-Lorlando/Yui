<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
    <nav class="sticky top-0 z-10 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <div class="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6">
        <span class="font-bold text-lg">Yui</span>
        <NuxtLink
          to="/"
          class="text-sm text-gray-600 dark:text-gray-400 hover:text-primary-500 transition"
          active-class="text-primary-500 font-medium"
          exact-active-class="text-primary-500 font-medium"
        >
          Status
        </NuxtLink>
        <NuxtLink
          to="/tools"
          class="text-sm text-gray-600 dark:text-gray-400 hover:text-primary-500 transition"
          active-class="text-primary-500 font-medium"
        >
          MCP Tools
        </NuxtLink>
        <span class="text-gray-200 dark:text-gray-700 select-none">|</span>
        <NuxtLink
          to="/scenes"
          class="text-sm text-gray-600 dark:text-gray-400 hover:text-primary-500 transition"
          active-class="text-primary-500 font-medium"
        >
          Scènes
        </NuxtLink>
        <NuxtLink
          to="/schedules"
          class="text-sm text-gray-600 dark:text-gray-400 hover:text-primary-500 transition"
          active-class="text-primary-500 font-medium"
        >
          Routines
        </NuxtLink>
        <NuxtLink
          to="/timers"
          class="text-sm text-gray-600 dark:text-gray-400 hover:text-primary-500 transition"
          active-class="text-primary-500 font-medium"
        >
          Timers
        </NuxtLink>
        <NuxtLink
          to="/memory"
          class="text-sm text-gray-600 dark:text-gray-400 hover:text-primary-500 transition"
          active-class="text-primary-500 font-medium"
        >
          Mémoire
        </NuxtLink>
        <NuxtLink
          to="/presence"
          class="text-sm text-gray-600 dark:text-gray-400 hover:text-primary-500 transition"
          active-class="text-primary-500 font-medium"
        >
          Présence
        </NuxtLink>
        <NuxtLink
          to="/prompts"
          class="text-sm text-gray-600 dark:text-gray-400 hover:text-primary-500 transition"
          active-class="text-primary-500 font-medium"
        >
          Prompts
        </NuxtLink>
        <div class="ml-auto">
          <UButton
            icon="i-heroicons-moon"
            variant="ghost"
            color="gray"
            size="sm"
            @click="toggleColorMode"
          />
        </div>
      </div>
    </nav>

    <div class="max-w-7xl mx-auto px-6">
      <NuxtPage />
    </div>

    <UNotifications />
  </div>
</template>

<script setup lang="ts">
const colorMode = useColorMode()

function toggleColorMode() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
</script>
