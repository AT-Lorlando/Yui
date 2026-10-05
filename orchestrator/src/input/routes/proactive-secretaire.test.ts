import assert from 'assert';
import express from 'express';
import http from 'http';
import { configRoutes } from './config';
import { mailRoutes } from './mail';
import type { ProactiveHandler } from '../InputSource';

process.on('unhandledRejection', () => {
    console.error('unhandled rejection');
    process.exit(1);
});

const requireAuth = (req: any, res: any, next: any) =>
    req.headers.authorization === 'Bearer t'
        ? next()
        : res.status(401).json({ error: 'unauthorized' });

async function serve(h: ProactiveHandler | undefined) {
    const app = express();
    app.use(express.json());
    app.use('/', configRoutes(requireAuth as any, undefined, h));
    app.use('/', mailRoutes(requireAuth as any, h));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const call = async (method: string, url: string, auth = 'Bearer t') => {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: { authorization: auth },
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { call, close: () => server.close() };
}

async function run(): Promise<void> {
    const seen: any = {};
    const h: ProactiveHandler = {
        reload: () => {},
        journal: (limit, before) => {
            seen.journal = { limit, before };
            return [];
        },
        held: () => [{ source: 'mail', key: 'k' }],
        heldRemove: (key) => {
            seen.heldKey = key;
            return key === 'mail:k 1/x';
        },
        said: () => [{ subject: 'a:1', nature: 'info' }],
        saidForget: (s) => {
            seen.saidSubject = s;
            return s === 'a:1/b';
        },
        saidForgetAll: () => 3,
        mailJournal: (limit, scope) => {
            seen.mail = { limit, scope };
            return [];
        },
    };
    const { call, close } = await serve(h);

    let r = await call('GET', '/proactive/journal?limit=10&before=500');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(seen.journal, { limit: 10, before: 500 });
    await call('GET', '/proactive/journal');
    assert.strictEqual(seen.journal.limit, 60, 'défaut 60');
    await call('GET', '/proactive/journal?limit=-5');
    assert.strictEqual(seen.journal.limit, 60, 'négatif → défaut');
    await call('GET', '/proactive/journal?limit=abc');
    assert.strictEqual(seen.journal.limit, 60, 'non numérique → défaut');
    await call('GET', '/proactive/journal?limit=9999');
    assert.strictEqual(seen.journal.limit, 300, 'plafonné à 300');
    assert.strictEqual(seen.journal.before, undefined);
    assert.strictEqual(
        (await call('GET', '/proactive/journal?before=abc')).status,
        400,
    );
    assert.strictEqual(
        (await call('GET', '/proactive/journal', 'x')).status,
        401,
    );

    r = await call('GET', '/proactive/held');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, 1);
    assert.strictEqual((await call('GET', '/proactive/held', 'x')).status, 401);
    r = await call(
        'DELETE',
        '/proactive/held/' + encodeURIComponent('mail:k 1/x'),
    );
    assert.strictEqual(r.status, 200);
    assert.strictEqual(seen.heldKey, 'mail:k 1/x', 'clé décodée');
    assert.strictEqual(
        (await call('DELETE', '/proactive/held/mail%3Anope')).status,
        404,
    );
    assert.strictEqual(
        (await call('DELETE', '/proactive/held/a', 'x')).status,
        401,
    );

    assert.strictEqual((await call('GET', '/proactive/said')).status, 200);
    assert.strictEqual((await call('GET', '/proactive/said', 'x')).status, 401);
    r = await call('DELETE', '/proactive/said/' + encodeURIComponent('a:1/b'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(seen.saidSubject, 'a:1/b');
    assert.strictEqual(
        (await call('DELETE', '/proactive/said/zzz')).status,
        404,
    );
    r = await call('DELETE', '/proactive/said');
    assert.deepStrictEqual(r.body, { ok: true, removed: 3 });
    assert.strictEqual(
        (await call('DELETE', '/proactive/said', 'x')).status,
        401,
    );

    await call('GET', '/mail/journal?scope=actions&limit=5');
    assert.deepStrictEqual(seen.mail, { limit: 5, scope: 'actions' });
    await call('GET', '/mail/journal?scope=autre');
    assert.strictEqual(seen.mail.scope, undefined);
    close();

    // Sans handler : 503.
    const none = await serve(undefined);
    for (const [m, u] of [
        ['GET', '/proactive/held'],
        ['DELETE', '/proactive/held/k'],
        ['GET', '/proactive/said'],
        ['DELETE', '/proactive/said/k'],
        ['DELETE', '/proactive/said'],
    ])
        assert.strictEqual((await none.call(m, u)).status, 503, `${m} ${u}`);
    none.close();
    console.log('All proactive-secretaire route tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
