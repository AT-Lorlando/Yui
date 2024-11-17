import winston from 'winston';
import env from './env';

const colorizer = winston.format.colorize();
const { combine, timestamp, printf, simple } = winston.format;

function get_offset(c: string): string {
    const offset = 7;
    return ' '.repeat(offset - c.length);
}

const Logger = winston.createLogger({
    level: env.LOG_LEVEL || 'info',
    format: combine(
        simple(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        printf(({ timestamp, level, message }) => {
            const formattedMessage: string =
                typeof message === 'object'
                    ? JSON.stringify(message, null, 2)
                    : String(message) || '';
            return `${timestamp} ${get_offset(
                level,
            )}[${level.toLocaleUpperCase()}] - ${formattedMessage}`;
        }),
    ),
    transports: [
        new winston.transports.Console({
            format: combine(
                simple(),
                timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                printf(({ timestamp, level, message }) => {
                    const formattedMessage =
                        typeof message === 'object'
                            ? JSON.stringify(message, null, 2)
                            : message;

                    if (level === 'error') {
                        return (
                            `${colorizer.colorize(
                                level,
                                String(timestamp),
                            )} ${get_offset(level)}` +
                            colorizer.colorize(
                                level,
                                `[${level.toLocaleUpperCase()}] - ${formattedMessage}`,
                            )
                        );
                    } else {
                        return (
                            `${timestamp} ${get_offset(level)}` +
                            colorizer.colorize(
                                level,
                                `[${level.toLocaleUpperCase()}] - ${formattedMessage}`,
                            )
                        );
                    }
                }),
            ),
        }),
    ],
});

if (env.NODE_ENV === 'production') {
    Logger.add(
        new winston.transports.File({
            filename: 'error.log',
            level: 'error',
        }),
    );
    Logger.add(
        new winston.transports.File({
            filename: 'combined.log',
        }),
    );
}

export function testLogger() {
    Logger.info('[TEST] Information message');
    Logger.verbose('[TEST] Success message');
    Logger.warn('[TEST] Warning message');
    Logger.error('[TEST] Error message');
    Logger.debug('[TEST] Debug message');
}

export default Logger;
