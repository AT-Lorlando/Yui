/**
 * PM2 ecosystem for Yui satellite — Raspberry Pi
 * Start: pm2 start ecosystem.config.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const env = {
    SATELLITE_SERVER: process.env.SATELLITE_SERVER || 'ws://10.0.0.101:5050',
    WAKEWORD_MODEL: process.env.WAKEWORD_MODEL || '../assets/wakeword/yui.onnx',
    WAKEWORD_THRESHOLD: process.env.WAKEWORD_THRESHOLD || '0.5',
};

module.exports = {
    apps: [
        {
            name: 'yui-satellite',
            script: 'main.py',
            interpreter: 'python3',
            cwd: __dirname,
            args: [
                '--server', env.SATELLITE_SERVER,
                '--model', env.WAKEWORD_MODEL,
                '--threshold', env.WAKEWORD_THRESHOLD,
            ].join(' '),
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },
    ],
};
