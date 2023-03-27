import winston from 'winston';

const colorizer = winston.format.colorize();
const { 
    combine, timestamp, printf, simple,
    } = winston.format;

const myCustomLevels = {
    levels: {
      error: 0,
      warn: 1,
      success: 2,
      info: 3,
      debug: 4,
    },
    colors: {
      error: 'red',
      warn: 'yellow',
      success: 'green',
      info: 'blue',
      debug: 'magenta',
    },
  };

colorizer.addColors(myCustomLevels.colors);

function get_offset(c : string) : string {
    const offset = 7
    return ' '.repeat(offset - c.length)
}

export const logger = winston.createLogger({
    levels: myCustomLevels.levels,
    level: 'debug',
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
        )
    ),
    transports: [new winston.transports.Console()],
});