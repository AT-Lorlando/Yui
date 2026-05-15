// ecosystem.config.js
const { parsed: env } = require('dotenv').config({ path: __dirname + '/.env' })
const ROOT = __dirname

module.exports = {
  apps: [
    // ── TTS engine (XTTS v2) ────────────────────────────────────────────────
    {
      name: 'yui-tts',
      script: 'voice/tts_engine.py',
      interpreter: '/home/chuya/.venvs/xtts/bin/python',
      cwd: ROOT,
      env: { ...env, COQUI_TOS_AGREED: '1', XTTS_PORT: env.XTTS_PORT ?? '18770' },
      listen_timeout: 60000,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 15000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // ── Orchestrateur (LLM + MCP servers) ──────────────────────────────────
    {
      name: 'yui-orchestrator',
      script: 'orchestrator/dist/main.js',
      cwd: ROOT,
      env: {
        ...env,
        NODE_ENV: 'production',
        PORT: env.ORCHESTRATOR_PORT ?? '4000',
        HOST: '0.0.0.0',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // ── Voice server (WebSocket STT — attend TTS + orchestrator) ───────────
    {
      name: 'yui-voice',
      script: 'scripts/start-voice.sh',
      interpreter: 'bash',
      cwd: ROOT,
      env: {
        ...env,
        SATELLITE_WS_PORT: env.SATELLITE_WS_PORT ?? '5050',
        WHISPER_MODEL: env.WHISPER_MODEL ?? 'distil-large-v3-fr',
        WHISPER_DEVICE: env.WHISPER_DEVICE ?? 'cuda',
        WHISPER_COMPUTE_TYPE: env.WHISPER_COMPUTE_TYPE ?? 'float16',
        YUI_URL: `http://localhost:${env.ORCHESTRATOR_PORT ?? '4000'}/order`,
        XTTS_PORT: env.XTTS_PORT ?? '18770',
      },
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // ── Dashboard (Nuxt 3 — proxy vers l'orchestrateur) ────────────────────
    {
      name: 'yui-dashboard',
      script: 'dashboard/.output/server/index.mjs',
      cwd: ROOT,
      env: {
        ...env,
        NODE_ENV: 'production',
        PORT: env.DASHBOARD_PORT ?? '3000',
        HOST: '0.0.0.0',
        ORCHESTRATOR_URL: `http://localhost:${env.ORCHESTRATOR_PORT ?? '4000'}`,
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
}
