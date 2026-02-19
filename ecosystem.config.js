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
 */

const ROOT = __dirname;

module.exports = {
    apps: [
        // ── 1. XTTS TTS server ──────────────────────────────────────────────
        {
            name: 'yui-xtts',
            script: 'src/xtts_server.py',
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

        // ── 3. Voice pipeline ────────────────────────────────────────────────
        // scripts/start-voice.sh polls /health on both services above before
        // launching the pipeline — no race conditions.
        {
            name: 'yui-voice',
            script: 'scripts/start-voice.sh',
            interpreter: 'bash',
            cwd: ROOT,
            env: {
                TTS_ENGINE: 'xtts',
                TTS_SPEAKER: 'Salon',
                LOCAL_IP: '10.0.0.101',
                WHISPER_MODEL: 'small',
                WHISPER_LANG: 'fr',
                SPEAK_PORT: '3001',
            },
            autorestart: true,
            max_restarts: 5,
            restart_delay: 10000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },
    ],
};
