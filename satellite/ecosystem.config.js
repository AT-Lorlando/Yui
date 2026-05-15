/**
 * PM2 ecosystem for Yui satellite — Raspberry Pi
 * Start: pm2 start satellite_ecosystem.config.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const env = {
    ACCESS_KEY: process.env.ACCESS_KEY,
    SATELLITE_SERVER: process.env.SATELLITE_SERVER || 'ws://10.0.0.101:5050',
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
                '--access-key', env.ACCESS_KEY,
                '--keywords', 'jarvis',
                '--sensitivity', '0.9',
            ].join(' '),
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },
    ],
};
