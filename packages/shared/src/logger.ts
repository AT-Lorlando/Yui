import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import dotenv from 'dotenv';

dotenv.config({ path: '.env' });

const colorizer = winston.format.colorize();
const { combine, timestamp, printf, simple } = winston.format;

const TS = 'YYYY-MM-DD HH:mm:ss';

function get_offset(c: string): string {
    const offset = 7;
    return ' '.repeat(offset - c.length);
}

function msgText(message: unknown): string {
    return typeof message === 'object'
        ? JSON.stringify(message, null, 2)
        : String(message ?? '');
}

/**
 * Sous-systèmes ayant leur propre fichier de log. Détection via le préfixe du
 * message (`[presence] …`, `proactive …`, `Scene …`). Convention : préfixer les
 * messages d'un sous-système par `[nom]` et l'ajouter ici pour obtenir
 * `logs/<nom>-<date>.log`.
 */
const SUBSYSTEMS = [
    'presence',
    'proactive',
    'hue-remotes',
    'notify',
    'automation',
    'scene',
    'mcp',
];

/** Tague `info.subsystem` à partir du préfixe `[nom]` ou `nom` du message. */
const withSubsystem = winston.format((info) => {
    const m = msgText(info.message).toLowerCase();
    for (const sub of SUBSYSTEMS) {
        if (m.startsWith(`[${sub}]`) || m.startsWith(sub)) {
            (info as Record<string, unknown>).subsystem = sub;
            break;
        }
    }
    return info;
});

const fileLine = printf(({ timestamp, level, message }) => {
    return `${timestamp} ${get_offset(
        level,
    )}[${level.toLocaleUpperCase()}] - ${msgText(message)}`;
});

const consoleLine = printf(({ timestamp, level, message }) => {
    const body = `[${level.toLocaleUpperCase()}] - ${msgText(message)}`;
    if (level === 'error') {
        return (
            `${colorizer.colorize(level, String(timestamp))} ${get_offset(
                level,
            )}` + colorizer.colorize(level, body)
        );
    }
    return (
        `${timestamp} ${get_offset(level)}` + colorizer.colorize(level, body)
    );
});

const Logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(simple(), withSubsystem(), timestamp({ format: TS })),
    transports: [
        new winston.transports.Console({
            format: combine(simple(), timestamp({ format: TS }), consoleLine),
        }),
    ],
});

/**
 * Fichiers rotatifs activés uniquement si `LOG_DIR` est défini (côté
 * orchestrateur via ecosystem.config.js). Les MCP spawné sans `LOG_DIR`
 * restent console-only → pas de contention multi-process sur les fichiers.
 *
 * Fichiers produits dans `LOG_DIR` :
 *   - app-<date>.log      tout
 *   - error-<date>.log    erreurs seules
 *   - <sous-système>-<date>.log  (presence, proactive, …)
 * Rotation quotidienne, taille max `LOG_MAX_SIZE` (20m), rétention
 * `LOG_MAX_FILES` (14d).
 */
const LOG_DIR = process.env.LOG_DIR;
if (LOG_DIR) {
    const maxSize = process.env.LOG_MAX_SIZE || '20m';
    const maxFiles = process.env.LOG_MAX_FILES || '14d';

    const rotate = (opts: {
        filename: string;
        level?: string;
        subsystem?: string;
    }): DailyRotateFile => {
        const fmts: winston.Logform.Format[] = [simple(), withSubsystem()];
        if (opts.subsystem) {
            fmts.push(
                winston.format((info) =>
                    (info as Record<string, unknown>).subsystem ===
                    opts.subsystem
                        ? info
                        : false,
                )(),
            );
        }
        fmts.push(timestamp({ format: TS }), fileLine);
        return new DailyRotateFile({
            dirname: LOG_DIR,
            filename: `${opts.filename}-%DATE%.log`,
            datePattern: 'YYYY-MM-DD',
            maxSize,
            maxFiles,
            level: opts.level,
            format: combine(...fmts),
        });
    };

    Logger.add(rotate({ filename: 'app' }));
    Logger.add(rotate({ filename: 'error', level: 'error' }));
    for (const sub of SUBSYSTEMS) {
        Logger.add(rotate({ filename: sub, subsystem: sub }));
    }
}

export default Logger;
