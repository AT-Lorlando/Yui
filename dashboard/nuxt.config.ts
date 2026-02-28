export default defineNuxtConfig({
  modules: ['@nuxt/ui'],

  runtimeConfig: {
    // Server-only — never exposed to the browser
    orchestratorUrl: process.env.ORCHESTRATOR_URL || 'http://localhost:3000',
    bearerToken: process.env.BEARER_TOKEN || 'yui',
  },

  nitro: {
    preset: 'node-server',
  },

  devServer: {
    port: 3002,
  },

  compatibilityDate: '2024-11-01',
})
