import winston from 'winston';
import dotenv from 'dotenv';
import { env } from './env';
dotenv.config();


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
                return `${timestamp} ${get_offset(level)}[${level.toLocaleUpperCase()}] - ${message}`;
            }
        )
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
                    return colorizer.colorize(
                    level,
                    `${timestamp} ${get_offset(level)}[${level.toLocaleUpperCase()}] - ${message}`,
                    );
                },
            ),
        ),
    }));
}

export { logger };