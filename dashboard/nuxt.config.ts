const orchUrl = process.env.ORCHESTRATOR_URL ?? `http://localhost:${process.env.ORCHESTRATOR_PORT ?? 4000}`

export default defineNuxtConfig({
  modules: ['@nuxt/ui'],

  nitro: {
    preset: 'node-server',
  },

  routeRules: {
    // ── Orchestrator proxy (prefixed /api/orch/ to avoid conflicts with /api/pm2/) ──
    '/api/orch/status':       { proxy: `${orchUrl}/status` },
    '/api/orch/tools':        { proxy: `${orchUrl}/tools` },
    '/api/orch/tools/**':     { proxy: `${orchUrl}/tools/**` },
    '/api/orch/order':        { proxy: `${orchUrl}/order` },
    '/api/orch/order/stream': { proxy: `${orchUrl}/order/stream` },
    '/api/orch/devices/**':   { proxy: `${orchUrl}/devices/**` },
    '/api/orch/scenes':       { proxy: `${orchUrl}/scenes` },
    '/api/orch/scenes/**':    { proxy: `${orchUrl}/scenes/**` },
    '/api/orch/schedules':    { proxy: `${orchUrl}/schedules` },
    '/api/orch/schedules/**': { proxy: `${orchUrl}/schedules/**` },
    '/api/orch/memory':       { proxy: `${orchUrl}/memory` },
    '/api/orch/timers':       { proxy: `${orchUrl}/timers` },
    '/api/orch/presence':     { proxy: `${orchUrl}/presence` },
    '/api/orch/prompts':      { proxy: `${orchUrl}/prompts` },
    '/api/orch/location':     { proxy: `${orchUrl}/location` },
    // ── Static assets (served directly by orchestrator) ──────────────────────
    '/chime':         { proxy: `${orchUrl}/chime` },
    '/chimes/**':     { proxy: `${orchUrl}/chimes/**` },
    '/ringtones/**':  { proxy: `${orchUrl}/ringtones/**` },
    '/media/**':      { proxy: `${orchUrl}/media/**` },
  },

  runtimeConfig: {
    public: {
      bearerToken: process.env.BEARER_TOKEN ?? '',
    },
  },
  compatibilityDate: '2024-11-01',
})
