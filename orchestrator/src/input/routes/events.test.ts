import assert from 'assert';
import express from 'express';
import http from 'http';
import { eventRoutes } from './events';

async function run(): Promise<void> {
    const seen: unknown[] = [];
    const app = express();
    app.use(express.json());
    const requireAuth = (req: any, res: any, next: any) =>
        req.headers.authorization === 'Bearer t'
            ? next()
            : res.status(401).json({ error: 'unauthorized' });
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
                };
            },
        }),
    );
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const post = (body: unknown, auth = 'Bearer t') =>
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
    server.close();
    console.log('All events route tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
