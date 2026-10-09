// packages/shared/src/logger.test.ts
//
// enableJsonConsole() bascule le transport Console du process en JSON (une
// ligne = un objet) pour le pipeline de logs Koya (Vector → ClickHouse). On
// capture process.stdout.write pour vérifier les lignes réellement émises
// par le Logger winston partagé, plutôt que de retester le comportement
// interne de winston.

import assert from 'assert';
import { Logger, enableJsonConsole } from './index';

type Captured = string[];

/** Capture les lignes écrites sur stdout pendant `fn()` (le transport Console
 * de winston écrit via process.stdout.write). */
function captureStdout(fn: () => void): Captured {
    const lines: Captured = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: unknown): boolean => {
        lines.push(String(chunk));
        return true;
    };
    try {
        fn();
    } finally {
        process.stdout.write = original;
    }
    return lines;
}

function parseAll(lines: Captured): Record<string, unknown>[] {
    return lines.map((l) => {
        assert.ok(
            l.endsWith('\n'),
            `line should end with \\n: ${JSON.stringify(l)}`,
        );
        const trimmed = l.slice(0, -1);
        assert.doesNotThrow(
            () => JSON.parse(trimmed),
            `line should be valid JSON: ${trimmed}`,
        );
        return JSON.parse(trimmed);
    });
}

function run(): void {
    enableJsonConsole({ app: 'yui', service: 'orchestrator' });

    // one parseable JSON object per log entry, with the required base fields
    {
        const lines = captureStdout(() => {
            Logger.info('Starting Yui…');
        });
        assert.strictEqual(lines.length, 1);
        const [entry] = parseAll(lines);
        assert.strictEqual(entry.level, 'info');
        assert.strictEqual(entry.msg, 'Starting Yui…');
        assert.strictEqual(entry.app, 'yui');
        assert.strictEqual(entry.service, 'orchestrator');
        assert.strictEqual(entry.env, process.env.NODE_ENV ?? 'production');
        assert.strictEqual(typeof entry.time, 'number');
        assert.ok((entry.time as number) > 0);
    }

    // level mapping: verbose/silly/http collapse to debug, others pass through
    {
        const prevLevel = Logger.level;
        Logger.level = 'silly';
        const lines = captureStdout(() => {
            Logger.warn('a warning');
            Logger.verbose('a verbose line');
            Logger.silly('a silly line');
        });
        Logger.level = prevLevel;
        const entries = parseAll(lines);
        assert.strictEqual(entries[0].level, 'warn');
        assert.strictEqual(entries[1].level, 'debug');
        assert.strictEqual(entries[2].level, 'debug');
    }

    // object messages are JSON-stringified compactly into msg
    {
        const lines = captureStdout(() => {
            // single-object log() API: the only winston call shape that keeps
            // `message` as a genuine object by the time transports see it.
            (Logger.log as (entry: unknown) => void)({
                level: 'info',
                message: { foo: 'bar', n: 1 },
            });
        });
        const [entry] = parseAll(lines);
        assert.strictEqual(entry.msg, '{"foo":"bar","n":1}');
        assert.ok(
            !(entry.msg as string).includes('\n'),
            'msg must be compact (no newlines)',
        );
    }

    // Error passed directly as the message → err {type, message, stack}
    {
        const lines = captureStdout(() => {
            Logger.error(new Error('direct error object'));
        });
        const [entry] = parseAll(lines);
        assert.strictEqual(entry.level, 'error');
        assert.strictEqual(entry.msg, 'direct error object');
        const err = entry.err as {
            type: string;
            message: string;
            stack?: string;
        };
        assert.ok(err, 'err should be present');
        assert.strictEqual(err.type, 'Error');
        assert.strictEqual(err.message, 'direct error object');
        assert.ok(
            err.stack && err.stack.startsWith('Error: direct error object'),
        );
    }

    // Error passed as a second (meta) argument → err {type, message, stack}
    {
        const lines = captureStdout(() => {
            Logger.error('context message', new Error('meta error object'));
        });
        const [entry] = parseAll(lines);
        assert.strictEqual(entry.level, 'error');
        assert.ok((entry.msg as string).includes('context message'));
        assert.ok((entry.msg as string).includes('meta error object'));
        const err = entry.err as {
            type: string;
            message: string;
            stack?: string;
        };
        assert.ok(err, 'err should be present');
        assert.strictEqual(err.type, 'Error');
        assert.strictEqual(err.message, 'meta error object');
        assert.ok(
            err.stack && err.stack.startsWith('Error: meta error object'),
        );
    }

    // `[presence] …` prefix → subsystem tag, and no err for plain messages
    {
        const lines = captureStdout(() => {
            Logger.info('[presence] someone arrived home');
        });
        const [entry] = parseAll(lines);
        assert.strictEqual(entry.subsystem, 'presence');
        assert.strictEqual(entry.err, undefined);
    }

    // never colourised: no ANSI escape codes in JSON mode
    {
        const lines = captureStdout(() => {
            Logger.error('an error line');
            Logger.warn('a warning line');
            Logger.info('an info line');
        });
        for (const line of lines) {
            assert.ok(
                !/\u001b\[/.test(line),
                `line should have no ANSI codes: ${line}`,
            );
        }
    }

    console.log('All logger tests passed');
}

run();
