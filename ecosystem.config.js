// ecosystem.config.js
const { parsed: env } = require('dotenv').config({ path: __dirname + '/.env' })

module.exports = {
  apps: [
    // ── TTS engine (XTTS v2) ────────────────────────────────────────────────
    {
      name: 'yui-tts',
      script: 'voice/tts_engine.py',
      cwd: __dirname,
      interpreter: '/home/chuya/.venvs/xtts/bin/python',
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
      cwd: __dirname,
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
      cwd: __dirname,
      interpreter: 'bash',
      env: {
        ...env,
        AUDIO_UDP_PORT: env.AUDIO_UDP_PORT ?? '5002',
        DEBUG_WS_PORT: env.DEBUG_WS_PORT ?? '5051',
        WAKEWORD_MODEL: env.WAKEWORD_MODEL ?? 'assets/wakeword/yui.onnx',
        WAKEWORD_THRESHOLD: env.WAKEWORD_THRESHOLD ?? '0.5',
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

    // ── App unifié (Nuxt 4 web build — remplace l'ancien dashboard) ────────
    {
      name: 'yui-app',
      script: 'mobile/.output/server/index.mjs',
      cwd: __dirname,
      env: {
        ...env,
        NODE_ENV: 'production',
        PORT: env.APP_PORT ?? '3000',
        HOST: '0.0.0.0',
        ORCHESTRATOR_URL: `http://localhost:${env.ORCHESTRATOR_PORT ?? '4000'}`,
        NUXT_PUBLIC_BEARER_TOKEN: env.BEARER_TOKEN ?? 'yui',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
}
