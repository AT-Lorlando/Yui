import assert from 'assert';
import express from 'express';
import http from 'http';
import { eventRoutes } from './events';

process.on('unhandledRejection', () => {
    console.error('unhandled rejection');
    process.exit(1);
});

async function listen(app: express.Express): Promise<{
    port: number;
    close: () => void;
}> {
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    return {
        port: (server.address() as any).port,
        close: () => server.close(),
    };
}

const requireAuth = (req: any, res: any, next: any) =>
    req.headers.authorization === 'Bearer t'
        ? next()
        : res.status(401).json({ error: 'unauthorized' });

async function run(): Promise<void> {
    const seen: unknown[] = [];
    const app = express();
    app.use(express.json());
    app.use(
        '/',
        eventRoutes(requireAuth as any, {
            ingest: async (events) => {
                seen.push(...events);
                return {
                    accepted: events.length,
                    deduplicated: 0,
                    expired: 0,
                    held: 0,
                    ignored: 0,
                };
            },
        }),
    );
    const main = await listen(app);
    const post = (body: unknown, auth = 'Bearer t', port = main.port) =>
        fetch(`http://127.0.0.1:${port}/events`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: auth,
            },
            body: JSON.stringify(body),
        });

    const ok = await post({
        source: 'koya',
        key: 'disk',
        kind: 'alert',
        importance: 'utile',
        subject: 'Disque 94 %',
    });
    assert.strictEqual(ok.status, 202);
    assert.deepStrictEqual(await ok.json(), {
        accepted: 1,
        deduplicated: 0,
        expired: 0,
        held: 0,
        ignored: 0,
    });
    assert.strictEqual(seen.length, 1);

    const bad = await post([
        {
            source: 'koya',
            key: 'a',
            kind: 'alert',
            importance: 'utile',
            subject: 'x',
        },
        { source: 'koya' },
    ]);
    assert.strictEqual(bad.status, 400);
    const body = (await bad.json()) as { errors: { index: number }[] };
    assert.deepStrictEqual(
        body.errors.map((e) => e.index),
        [1],
    );
    assert.strictEqual(seen.length, 1, 'tout ou rien : rien d’ingéré');

    assert.strictEqual((await post({}, 'Bearer nope')).status, 401);

    // 413 : corps > 32 Ko, refusé AVANT toute validation — même si les champs
    // dépasseraient de toute façon les bornes de parseEvents (facts/subject),
    // c'est bien la taille brute qui doit déclencher le rejet.
    const big = await post({
        source: 'koya',
        key: 'big',
        kind: 'alert',
        importance: 'utile',
        subject: 'x',
        facts: Array.from({ length: 10 }, () => 'x'.repeat(4096)),
    });
    assert.strictEqual(big.status, 413);
    assert.strictEqual(seen.length, 1, '413 : rien d’ingéré non plus');

    main.close();

    // 503 : proactivité non câblée (pas de `ingest`).
    const noProactiveApp = express();
    noProactiveApp.use(express.json());
    noProactiveApp.use('/', eventRoutes(requireAuth as any, {}));
    const noProactive = await listen(noProactiveApp);
    const unavailable = await fetch(
        `http://127.0.0.1:${noProactive.port}/events`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer t',
            },
            body: JSON.stringify({
                source: 'koya',
                key: 'x',
                kind: 'alert',
                importance: 'utile',
                subject: 'x',
            }),
        },
    );
    assert.strictEqual(unavailable.status, 503);
    noProactive.close();

    // 500 : l'engine rejette — la route répond 500 et ne laisse rien fuiter
    // (pas de rejet non intercepté, le process doit sortir proprement).
    const failingApp = express();
    failingApp.use(express.json());
    failingApp.use(
        '/',
        eventRoutes(requireAuth as any, {
            ingest: async () => {
                throw new Error('boom');
            },
        }),
    );
    const failing = await listen(failingApp);
    const failed = await fetch(`http://127.0.0.1:${failing.port}/events`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer t',
        },
        body: JSON.stringify({
            source: 'koya',
            key: 'x',
            kind: 'alert',
            importance: 'utile',
            subject: 'x',
        }),
    });
    assert.strictEqual(failed.status, 500);
    assert.deepStrictEqual(await failed.json(), { error: 'ingestion échouée' });
    failing.close();

    console.log('All events route tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
