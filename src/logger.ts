import winston from 'winston';
import env from './env';

const colorizer = winston.format.colorize();
const { combine, timestamp, printf, simple } = winston.format;

function get_offset(c: string): string {
    const offset = 7;
    return ' '.repeat(offset - c.length);
}

export const logger = winston.createLogger({
    level: env.LOG_LEVEL || 'info',
    format: combine(
        simple(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        printf(({ timestamp, level, message }) => {
            const formattedMessage: string =
                typeof message === 'object'
                    ? JSON.stringify(message, null, 2)
                    : message;
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
                                timestamp,
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
    logger.add(
        new winston.transports.File({
            filename: 'error.log',
            level: 'error',
        }),
    );
    logger.add(
        new winston.transports.File({
            filename: 'combined.log',
        }),
    );
}

export function testLogger() {
    logger.info('Information message');
    logger.verbose('Success message');
    logger.warn('Warning message');
    logger.error('Error message');
    logger.debug('Debug message');
}
