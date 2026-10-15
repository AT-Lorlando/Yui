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
    const call = async (
        method: string,
        url: string,
        auth = 'Bearer t',
        body?: unknown,
    ) => {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: {
                authorization: auth,
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
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
        decideHeld: async (key, channel) => {
            seen.decideHeld = { key, channel };
            if (key === 'mail:old') {
                const err = new Error('trop ancien');
                err.name = 'DecisionExpired';
                throw err;
            }
            if (key !== 'mail:k 1/x') {
                const err = new Error('introuvable');
                err.name = 'DecisionNotFound';
                throw err;
            }
            return { channel, message: 'Sujet. Fait' };
        },
        decideJournal: async (id, channel) => {
            seen.decideJournal = { id, channel };
            if (id === 'boom') throw new Error('panne');
            return { channel, message: 'M' };
        },
        watches: () => ({ watches: [{ id: 'w-1' }], orders: [] }),
        watchAdd: (input) => {
            seen.watchAdd = input;
            if (input.what.length < 5) throw new Error('texte trop court');
            return { id: 'w-2', text: input.what };
        },
        watchRemove: (id) => {
            seen.watchRemove = id;
            return id === 'w-1';
        },
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

    // ── Décisions manuelles ──────────────────────────────────────────
    r = await call(
        'POST',
        '/proactive/held/' + encodeURIComponent('mail:k 1/x') + '/decide',
        'Bearer t',
        { channel: 'speak' },
    );
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, {
        ok: true,
        channel: 'speak',
        message: 'Sujet. Fait',
    });
    assert.deepStrictEqual(seen.decideHeld, {
        key: 'mail:k 1/x',
        channel: 'speak',
    });
    for (const body of [{ channel: 'hold' }, {}, undefined]) {
        assert.strictEqual(
            (await call('POST', '/proactive/held/a/decide', 'Bearer t', body))
                .status,
            400,
            `canal invalide ${JSON.stringify(body)}`,
        );
    }
    assert.strictEqual(
        (
            await call(
                'POST',
                '/proactive/held/mail%3Anope/decide',
                'Bearer t',
                {
                    channel: 'skip',
                },
            )
        ).status,
        404,
    );
    assert.strictEqual(
        (
            await call(
                'POST',
                '/proactive/held/mail%3Aold/decide',
                'Bearer t',
                {
                    channel: 'skip',
                },
            )
        ).status,
        410,
    );
    assert.strictEqual(
        (
            await call('POST', '/proactive/held/a/decide', 'x', {
                channel: 'skip',
            })
        ).status,
        401,
    );
    r = await call('POST', '/proactive/journal/j1/decide', 'Bearer t', {
        channel: 'notify',
    });
    assert.deepStrictEqual(r.body, {
        ok: true,
        channel: 'notify',
        message: 'M',
    });
    assert.deepStrictEqual(seen.decideJournal, { id: 'j1', channel: 'notify' });
    assert.strictEqual(
        (
            await call('POST', '/proactive/journal/boom/decide', 'Bearer t', {
                channel: 'notify',
            })
        ).status,
        500,
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

    // ── Attentes ─────────────────────────────────────────────────────
    r = await call('GET', '/proactive/watches');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { watches: [{ id: 'w-1' }], orders: [] });
    assert.strictEqual(
        (await call('GET', '/proactive/watches', 'x')).status,
        401,
    );
    r = await call('POST', '/proactive/watches', 'Bearer t', {
        what: 'la réponse de Michel',
        keywords: ['michel'],
        days: 3,
    });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.body, { id: 'w-2', text: 'la réponse de Michel' });
    assert.deepStrictEqual(seen.watchAdd, {
        what: 'la réponse de Michel',
        keywords: ['michel'],
        days: 3,
        origin: 'app',
    });
    r = await call('POST', '/proactive/watches', 'Bearer t', {
        what: 'le colis',
        source: 'deliveries',
        keywords: ['amazon'],
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(seen.watchAdd.source, 'deliveries');
    r = await call('POST', '/proactive/watches', 'Bearer t', {
        what: 'abc',
        keywords: ['x'],
    });
    assert.strictEqual(r.status, 400, 'erreur du store → 400');
    assert.strictEqual(r.body.error, 'texte trop court');
    for (const bad of [
        { keywords: ['x'] },
        { what: 'assez long', keywords: 'x' },
        { what: 'assez long', keywords: [1] },
        { what: 'assez long', keywords: ['x'], days: '3' },
        { what: 'assez long', keywords: ['x'], source: 4 },
    ])
        assert.strictEqual(
            (await call('POST', '/proactive/watches', 'Bearer t', bad)).status,
            400,
            JSON.stringify(bad),
        );
    assert.strictEqual(
        (
            await call('POST', '/proactive/watches', 'x', {
                what: 'la réponse',
                keywords: ['x'],
            })
        ).status,
        401,
    );
    r = await call('DELETE', '/proactive/watches/w-1');
    assert.deepStrictEqual(r.body, { ok: true });
    assert.strictEqual(seen.watchRemove, 'w-1');
    assert.strictEqual(
        (await call('DELETE', '/proactive/watches/w-9')).status,
        404,
    );
    assert.strictEqual(
        (await call('DELETE', '/proactive/watches/w-1', 'x')).status,
        401,
    );

    await call('GET', '/mail/journal?scope=actions&limit=5');
    assert.deepStrictEqual(seen.mail, { limit: 5, scope: 'actions' });
    await call('GET', '/mail/journal?scope=autre');
    assert.strictEqual(seen.mail.scope, undefined);
    close();

    // Sans handler : 503.
    const none = await serve(undefined);
    assert.strictEqual(
        (
            await none.call('POST', '/proactive/watches', 'Bearer t', {
                what: 'la réponse',
                keywords: ['x'],
            })
        ).status,
        503,
    );
    for (const u of ['/proactive/held/k/decide', '/proactive/journal/j/decide'])
        assert.strictEqual(
            (await none.call('POST', u, 'Bearer t', { channel: 'skip' }))
                .status,
            503,
            u,
        );
    for (const [m, u] of [
        ['GET', '/proactive/held'],
        ['DELETE', '/proactive/held/k'],
        ['GET', '/proactive/said'],
        ['DELETE', '/proactive/said/k'],
        ['DELETE', '/proactive/said'],
        ['GET', '/proactive/watches'],
        ['DELETE', '/proactive/watches/w-1'],
    ])
        assert.strictEqual((await none.call(m, u)).status, 503, `${m} ${u}`);
    none.close();
    console.log('All proactive-secretaire route tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
