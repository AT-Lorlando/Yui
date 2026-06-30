module.exports = {
    apps: [
        // ── Orchestrateur (LLM + MCP servers) ──────────────────────────────────
        {
            name: 'yui-orchestrator',
            script: 'orchestrator/dist/main.js',
            cwd: './',
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            // Logs rotatifs + par sous-système dans <cwd>/logs (cf packages/shared/src/logger.ts).
            // Seul l'orchestrateur définit LOG_DIR → les MCP spawné restent console-only.
            env: {
                LOG_DIR: 'logs',
                LOG_MAX_SIZE: '20m',
                LOG_MAX_FILES: '14d',
            },
        },

        // ── TTS engine (XTTS v2) ────────────────────────────────────────────────
        {
            name: 'yui-tts',
            script: 'start-tts.sh',
            cwd: './voice',
            interpreter: 'bash',
            listen_timeout: 60000,
            autorestart: true,
            max_restarts: 5,
            restart_delay: 15000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },

        // ── Voice server (WebSocket STT — attend TTS + orchestrator) ───────────
        {
            name: 'yui-voice',
            script: 'start.sh',
            cwd: './voice',
            interpreter: 'bash',
            autorestart: true,
            max_restarts: 5,
            restart_delay: 10000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },
    ],
};
