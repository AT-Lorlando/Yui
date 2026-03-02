/**
 * PM2 Ecosystem — Yui
 *
 * Start everything:   pm2 start ecosystem.config.js
 * Or via npm:         npm run pm2:start
 *
 * Startup order (enforced by scripts/start-voice.sh):
 *   1. yui-xtts        — XTTS v2 TTS server (Python 3.11 venv, port 18770)
 *   2. yui-orchestrator — MCP orchestrator (Node, port 3000)
 *   3. yui-voice        — Voice pipeline (waits for 1 + 2 via health checks)
 *   4. yui-dashboard    — Web control panel (Node, port 3002)
 */

const ROOT = __dirname;

module.exports = {
    apps: [
        // ── 1. XTTS TTS server ──────────────────────────────────────────────
        {
            name: 'yui-xtts',
            script: 'src/tts/xtts_server.py',
            interpreter: '/home/chuya/.venvs/xtts/bin/python',
            cwd: ROOT,
            env: {
                COQUI_TOS_AGREED: '1',
            },
            // Model load takes ~20s — give it time before declaring it crashed
            listen_timeout: 60000,
            autorestart: true,
            max_restarts: 5,
            restart_delay: 15000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },

        // ── 2. Orchestrator ─────────────────────────────────────────────────
        {
            name: 'yui-orchestrator',
            script: 'dist/main.js',
            cwd: ROOT,
            env: {
                NODE_ENV: 'production',
                LOG_LEVEL: 'info',
                SAVE_STORIES: 'true',
            },
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },

        // ── 3. Dashboard (Nuxt 3) ────────────────────────────────────────────
        {
            name: 'yui-dashboard',
            script: 'dashboard/.output/server/index.mjs',
            cwd: ROOT,
            env: {
                NODE_ENV: 'production',
                PORT: '3002',
                HOST: '0.0.0.0',
            },
            autorestart: true,
            max_restarts: 10,
            restart_delay: 3000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },

        // ── 4. Voice pipeline ────────────────────────────────────────────────
        // scripts/start-voice.sh polls /health on both services above before
        // launching the pipeline — no race conditions.
        {
            name: 'yui-voice',
            script: 'scripts/start-voice.sh',
            interpreter: 'bash',
            cwd: ROOT,
            env: {
                TTS_ENGINE: 'xtts',
                TTS_SPEAKER: 'Google Home',
                LOCAL_IP: '10.0.0.101',
                WHISPER_MODEL: 'large-v3-turbo',
                WHISPER_LANG: 'fr',
                SPEAK_PORT: '3001',
                TRIGGER_WORD: 'Lunix',
                // VAD thresholds — calibrated from observed noise floor (avg≈238, peak≈357)
                // Set SPEECH_THRESHOLD >> noise peak to avoid false triggers
                SPEECH_THRESHOLD: '1000',
                SILENCE_THRESHOLD: '400',
            },
            autorestart: true,
            max_restarts: 5,
            restart_delay: 10000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },
    ],
};
