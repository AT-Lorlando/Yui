const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const levels = ['error', 'warn', 'info', 'debug'];
const currentLevel = levels.indexOf(LOG_LEVEL);

const Logger = {
    error: (msg: string) => currentLevel >= 0 && console.error(`[mcp-irrigation] ERROR ${msg}`),
    warn:  (msg: string) => currentLevel >= 1 && console.error(`[mcp-irrigation] WARN  ${msg}`),
    info:  (msg: string) => currentLevel >= 2 && console.error(`[mcp-irrigation] INFO  ${msg}`),
    debug: (msg: string) => currentLevel >= 3 && console.error(`[mcp-irrigation] DEBUG ${msg}`),
};

export default Logger;
