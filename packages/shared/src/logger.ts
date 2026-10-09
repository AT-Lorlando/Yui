import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import dotenv from 'dotenv';

dotenv.config({ path: '.env' });

const colorizer = winston.format.colorize();
const { combine, timestamp, printf, simple } = winston.format;

const TS = 'YYYY-MM-DD HH:mm:ss';
const SPLAT = Symbol.for('splat');
const MESSAGE = Symbol.for('message');

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
 * `message` et `stack` sont des propriétés non énumérables sur les instances
 * `Error`. Quand un appelant fait `Logger.error(err)`, winston réutilise `err`
 * lui-même comme `info` (voir `Logger.prototype.log`, cas à 2 arguments) :
 * sans ce correctif, la copie superficielle (`Object.assign({}, info)`) que
 * chaque transport effectue avant d'appliquer son propre format perd
 * silencieusement `message`/`stack`. On les rend énumérables en place, tôt
 * dans le pipeline partagé, pour que les formats par transport (dont le JSON
 * de la console) puissent encore les lire. N'affecte que les appels passant
 * une `Error` en message direct — aucun site d'appel actuel ne le fait, donc
 * le texte produit dans les fichiers rotatifs ne change pas en pratique.
 */
const liftErrorProps = winston.format((info) => {
    if (info instanceof Error) {
        const err = info as Error;
        if (!Object.getOwnPropertyDescriptor(err, 'message')?.enumerable) {
            Object.defineProperty(err, 'message', {
                value: err.message,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
        if (!Object.getOwnPropertyDescriptor(err, 'stack')?.enumerable) {
            Object.defineProperty(err, 'stack', {
                value: err.stack,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
    }
    return info;
});

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

const consoleTransport = new winston.transports.Console({
    format: combine(simple(), timestamp({ format: TS }), consoleLine),
});

const Logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(
        liftErrorProps(),
        simple(),
        withSubsystem(),
        timestamp({ format: TS }),
    ),
    transports: [consoleTransport],
});

/**
 * Niveaux JSON exposés au pipeline de logs Koya (Vector → ClickHouse) :
 * `verbose`/`silly`/`http` (winston) n'ont pas d'équivalent côté Koya et sont
 * ramenés à `debug`.
 */
const JSON_LEVEL: Record<string, 'error' | 'warn' | 'info' | 'debug'> = {
    error: 'error',
    warn: 'warn',
    info: 'info',
    debug: 'debug',
    verbose: 'debug',
    silly: 'debug',
    http: 'debug',
};

interface JsonErr {
    type: string;
    message: string;
    stack?: string;
}

/** Nom de l'exception extrait de la 1ère ligne de `stack` ("TypeError: …"). */
function errorTypeFromStack(stack: string): string {
    const firstLine = stack.split('\n', 1)[0] ?? '';
    const m = /^([^:\n]+):/.exec(firstLine);
    return m ? m[1].trim() : 'Error';
}

/**
 * Détecte une `Error` portée par l'appel de log, selon les deux formes
 * usuelles côté orchestrateur/MCP :
 *   - `Logger.error(err)`      → `err` devient `info` lui-même (cf.
 *     `liftErrorProps` ci-dessus pour la préservation de message/stack).
 *   - `Logger.error('x', err)` → `err` reste accessible via `info[SPLAT]`,
 *     winston fusionnant seulement `message`/`stack` sur `info`.
 */
function extractErr(
    info: Record<string | symbol, unknown>,
): JsonErr | undefined {
    const splat = info[SPLAT];
    if (Array.isArray(splat)) {
        const found = splat.find((a): a is Error => a instanceof Error);
        if (found) {
            return {
                type: found.constructor?.name || found.name || 'Error',
                message: found.message,
                stack: found.stack,
            };
        }
    }
    if (typeof info.stack === 'string' && info.stack) {
        return {
            type: errorTypeFromStack(info.stack),
            message:
                typeof info.message === 'string'
                    ? info.message
                    : String(info.message ?? ''),
            stack: info.stack,
        };
    }
    return undefined;
}

function jsonMsgText(message: unknown): string {
    if (message instanceof Error) return message.message;
    return typeof message === 'object' && message !== null
        ? JSON.stringify(message)
        : String(message ?? '');
}

/**
 * Format JSON (une ligne = un objet) consommé par le pipeline de logs Koya
 * (Vector → ClickHouse, cf. `backend/app/services/log_pipeline/vector_config.ts`
 * côté Koya). Jamais colorisé. N'altère que le transport Console : les
 * fichiers rotatifs de `LOG_DIR` gardent leur format texte existant.
 */
function jsonConsoleFormat(opts: {
    app: string;
    service: string;
}): winston.Logform.Format {
    return winston.format((info) => {
        const level = JSON_LEVEL[info.level] ?? 'info';
        const err = extractErr(info as Record<string | symbol, unknown>);
        const out: Record<string, unknown> = {
            time: Date.now(),
            level,
            msg: jsonMsgText(info.message),
            app: opts.app,
            service: opts.service,
            env: process.env.NODE_ENV ?? 'production',
        };
        const subsystem = (info as Record<string, unknown>).subsystem;
        if (subsystem) out.subsystem = subsystem;
        if (err) out.err = err;
        (info as Record<symbol, unknown>)[MESSAGE] = JSON.stringify(out);
        return info;
    })();
}

/**
 * Bascule le transport Console du process courant en JSON (une ligne par
 * entrée) pour que Vector le parse côté Koya. Fonction explicite plutôt
 * qu'une variable d'env : les serveurs MCP héritent de l'env de
 * l'orchestrateur et parlent MCP sur stdout — le mode JSON ne doit donc
 * jamais se propager par héritage d'env, seulement par cet appel explicite
 * fait par l'orchestrateur à son démarrage.
 */
export function enableJsonConsole(opts: {
    app: string;
    service: string;
}): void {
    consoleTransport.format = jsonConsoleFormat(opts);
}

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
