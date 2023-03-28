import winston from 'winston';
import env from './env';

const colorizer = winston.format.colorize();
const { 
    combine, timestamp, printf, simple
    } = winston.format;


function get_offset(c : string) : string {
    const offset = 7
    return ' '.repeat(offset - c.length)
}

const logger = winston.createLogger({
    level: 'silly',
    format: combine(
        simple(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        printf(
            ({ timestamp, level, message }) => {
                const formattedMessage = typeof message === "object" ? JSON.stringify(message, null, 2) : message;
                return `${timestamp} ${get_offset(level)}[${level.toLocaleUpperCase()}] - ${formattedMessage}`;
            }
        ),
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ],
});

if (env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: combine(
            simple(),
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            printf(
                ({ timestamp, level, message }) => {
                    const formattedMessage = typeof message === "object" ? JSON.stringify(message, null, 2) : message;

                    return colorizer.colorize(
                    level,
                    `${timestamp} ${get_offset(level)}[${level.toLocaleUpperCase()}] - ${formattedMessage}`,
                    );
                },
            ),
        ),
    }));
}

export { logger };