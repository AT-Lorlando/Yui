import assert from 'assert';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-wakeups-routes-'));
process.env.YUI_DATA_DIR = tmp;

const { wakeupRoutes } = require('./wakeups');
const {
    setWakeupRunner,
    WakeupNotFoundError,
} = require('../../orchestrator/wakeups/runner');

const requireAuth = (req: any, res: any, next: any) =>
    req.headers.authorization === 'Bearer t'
        ? next()
        : res.status(401).json({ error: 'unauthorized' });

async function serve() {
    const app = express();
    app.use(express.json());
    app.use('/', wakeupRoutes(requireAuth));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const call = (method: string, p: string, body?: unknown, auth = true) =>
        fetch(`http://127.0.0.1:${port}${p}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(auth ? { Authorization: 'Bearer t' } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    return { server, call };
}

/** Prochain 07:00 local à moins de 24 h. */
function next0700(): number {
    const d = new Date();
    d.setHours(7, 0, 0, 0);
    if (d.getTime() <= Date.now() + 60_000) d.setDate(d.getDate() + 1);
    return d.getTime();
}

async function run(): Promise<void> {
    const { server, call } = await serve();
    try {
        assert.strictEqual(
            (await call('GET', '/wakeups', undefined, false)).status,
            401,
        );
        assert.strictEqual(
            (await call('PUT', '/wakeups', {}, false)).status,
            401,
        );
        assert.strictEqual(
            (await call('POST', '/wake/phone-alarm', { nextAt: null }, false))
                .status,
            401,
        );
        assert.strictEqual(
            (await call('POST', '/wakeups/semaine/test', undefined, false))
                .status,
            401,
        );

        const g = (await (await call('GET', '/wakeups')).json()) as any;
        assert.strictEqual(g.wakeups.length, 1);
        assert.strictEqual(g.wakeups[0].id, 'semaine');
        assert.strictEqual(g.phoneAlarm, null);

        const bad = await call('PUT', '/wakeups', { wakeups: 'x' });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(typeof ((await bad.json()) as any).error, 'string');

        assert.strictEqual(
            (await call('POST', '/wake/phone-alarm', { nextAt: 'x' })).status,
            400,
        );
        const at = next0700();
        const pa = await call('POST', '/wake/phone-alarm', { nextAt: at });
        assert.strictEqual(pa.status, 200);
        const pab = (await pa.json()) as any;
        assert.strictEqual(pab.ok, true);
        assert.strictEqual(pab.phoneAlarm.nextAt, at);
        assert.strictEqual(pab.phoneAlarm.source, 'android');

        const g2 = (await (await call('GET', '/wakeups')).json()) as any;
        assert.strictEqual(g2.next[0].source, 'phone');
        assert.strictEqual('wakeup' in g2.next[0], false);

        const put = await call('PUT', '/wakeups', { wakeups: g2.wakeups });
        assert.strictEqual(put.status, 200);
        assert.strictEqual(
            ((await put.json()) as any).wakeups[0].id,
            'semaine',
        );

        // Sans runner : 503
        setWakeupRunner(null);
        const r503 = await call('POST', '/wakeups/semaine/test');
        assert.strictEqual(r503.status, 503);
        assert.strictEqual(
            ((await r503.json()) as any).error,
            'Réveils non démarrés',
        );

        // Runner factice
        let tested: string | null = null;
        let resched = 0;
        setWakeupRunner({
            next: () => [],
            reschedule: () => void resched++,
            test: async (id: string) => {
                tested = id;
                if (id === 'zzz') throw new WakeupNotFoundError(id);
            },
        });
        const r404 = await call('POST', '/wakeups/zzz/test');
        assert.strictEqual(r404.status, 404);
        assert.strictEqual(typeof ((await r404.json()) as any).error, 'string');
        const rok = await call('POST', '/wakeups/semaine/test');
        assert.strictEqual(rok.status, 200);
        assert.strictEqual(((await rok.json()) as any).ok, true);
        assert.strictEqual(tested, 'semaine');
        await call('PUT', '/wakeups', { wakeups: g2.wakeups });
        assert.ok(resched >= 1);
        setWakeupRunner(null);
    } finally {
        server.close();
    }
    console.log('wakeups routes ok');
}
run().catch((e) => {
    console.error(e);
    process.exit(1);
});
