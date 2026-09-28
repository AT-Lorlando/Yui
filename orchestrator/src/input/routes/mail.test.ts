import assert from 'assert';
import express from 'express';
import http from 'http';
import { mailRoutes } from './mail';
import type { MailHandler } from './mail';

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
    // ── Faux handler en mémoire ────────────────────────────────────────────
    const rules = [
        {
            id: 'r-user',
            when: { from: 'ami@x.fr' },
            then: { category: 'perso' },
            origin: 'user',
            confirmed: true,
            hits: 1,
            createdAt: 1,
        },
        {
            id: 'r1',
            when: { from: 'news@zalando.fr' },
            then: { category: 'newsletter' },
            origin: 'signal',
            confirmed: false,
            hits: 3,
            createdAt: 2,
        },
    ];
    const quarantineActs: Array<{ id: string; action: string; opts: any }> = [];
    const marked: string[] = [];
    let journalLimitSeen: number | undefined;
    const reading = [
        { id: 'm1', from: 'a@b.fr', subject: 'S', date: '2026', snippet: '…' },
    ];

    const handler: MailHandler = {
        mailRules: () => rules,
        mailRuleSave: (raw: any) => {
            if (
                !raw ||
                typeof raw !== 'object' ||
                !raw.when ||
                (!raw.when.from && !raw.when.subject && !raw.when.header)
            ) {
                return { ok: false, error: 'condition manquante' };
            }
            return {
                ok: true,
                rule: {
                    id: 'r-new',
                    when: raw.when,
                    then: { category: raw.then?.category ?? null },
                    origin: 'user',
                    confirmed: true,
                    hits: 0,
                    createdAt: 1,
                },
            };
        },
        mailRuleDelete: (id: string) => id === 'r-user',
        mailQuarantine: () => rules.filter((r) => r.origin === 'signal'),
        mailQuarantineAct: async (id, action, opts) => {
            quarantineActs.push({ id, action, opts });
            if (action === 'correct' && opts?.category === 'nope') {
                // même signal que le vrai concierge pour une catégorie
                // inconnue — la route doit le traduire en 400, pas 500.
                throw new Error('catégorie inconnue');
            }
            return id === 'r1';
        },
        mailReading: async () => reading,
        mailMarkRead: async (id: string) => {
            marked.push(id);
        },
        mailJournal: (limit?: number) => {
            journalLimitSeen = limit;
            return [];
        },
    };

    const app = express();
    app.use(express.json());
    app.use('/', mailRoutes(requireAuth as any, handler));
    const main = await listen(app);
    const base = `http://127.0.0.1:${main.port}`;
    const get = (p: string, auth = 'Bearer t') =>
        fetch(`${base}${p}`, { headers: { Authorization: auth } });
    const post = (p: string, body: unknown = {}, auth = 'Bearer t') =>
        fetch(`${base}${p}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: auth,
            },
            body: JSON.stringify(body),
        });
    const del = (p: string, auth = 'Bearer t') =>
        fetch(`${base}${p}`, {
            method: 'DELETE',
            headers: { Authorization: auth },
        });

    // ── 401 sans Bearer ────────────────────────────────────────────────────
    assert.strictEqual((await get('/mail/rules', 'Bearer nope')).status, 401);

    // ── GET /mail/rules : 200, signal non confirmé exclu ─────────────────
    const rulesRes = await get('/mail/rules');
    assert.strictEqual(rulesRes.status, 200);
    const rulesBody = (await rulesRes.json()) as Array<{ id: string }>;
    assert.deepStrictEqual(
        rulesBody.map((r) => r.id),
        ['r-user'],
        'la règle signal non confirmée reste dans la quarantaine, pas ici',
    );

    // ── POST /mail/rules : 400 sur condition vide, 200 sur règle valide ──
    const badRule = await post('/mail/rules', { when: {}, then: {} });
    assert.strictEqual(badRule.status, 400);
    const goodRule = await post('/mail/rules', {
        when: { from: 'x@y.fr' },
        then: { category: 'action' },
    });
    assert.strictEqual(goodRule.status, 200);
    assert.strictEqual((await goodRule.json()).id, 'r-new');

    // ── DELETE /mail/rules/:id ─────────────────────────────────────────────
    assert.strictEqual((await del('/mail/rules/r-user')).status, 200);
    assert.strictEqual((await del('/mail/rules/nope')).status, 404);

    // ── GET /mail/quarantine ────────────────────────────────────────────────
    const quarantineRes = await get('/mail/quarantine');
    assert.strictEqual(quarantineRes.status, 200);
    assert.strictEqual((await quarantineRes.json()).length, 1);

    // ── POST /mail/quarantine/:id/:action ─────────────────────────────────
    assert.strictEqual((await post('/mail/quarantine/r1/confirm')).status, 200);
    assert.deepStrictEqual(quarantineActs[0], {
        id: 'r1',
        action: 'confirm',
        opts: { category: undefined },
    });
    assert.strictEqual(
        (await post('/mail/quarantine/r1/correct', {})).status,
        400,
        'correct sans catégorie',
    );
    assert.strictEqual(
        (
            await post('/mail/quarantine/r1/correct', {
                category: 'perso',
            })
        ).status,
        200,
    );
    assert.strictEqual((await post('/mail/quarantine/zz/reject')).status, 404);
    assert.strictEqual(
        (await post('/mail/quarantine/r1/nawak')).status,
        400,
        'action inconnue',
    );
    // Catégorie fournie mais inconnue : 400 (requête mal formée), pas 404 ni
    // 500 — le concierge le signale par une erreur précise.
    const unknownCategory = await post('/mail/quarantine/r1/correct', {
        category: 'nope',
    });
    assert.strictEqual(unknownCategory.status, 400);
    assert.strictEqual(
        (await unknownCategory.json()).error,
        'catégorie inconnue',
    );

    // ── GET /mail/reading, POST /mail/reading/:id/read ────────────────────
    const readingRes = await get('/mail/reading');
    assert.strictEqual(readingRes.status, 200);
    assert.deepStrictEqual(await readingRes.json(), reading);
    assert.strictEqual((await post('/mail/reading/m1/read')).status, 200);
    assert.deepStrictEqual(marked, ['m1']);

    // ── GET /mail/journal : limite bornée à 200 ───────────────────────────
    assert.strictEqual((await get('/mail/journal?limit=999')).status, 200);
    assert.strictEqual(journalLimitSeen, 200, 'clampé à 200');
    await get('/mail/journal');
    assert.strictEqual(journalLimitSeen, 50, 'défaut 50');

    main.close();

    // ── 503 : proactivité non câblée (handler absent) ─────────────────────
    const bareApp = express();
    bareApp.use(express.json());
    bareApp.use('/', mailRoutes(requireAuth as any, {}));
    const bare = await listen(bareApp);
    const bareBase = `http://127.0.0.1:${bare.port}`;
    for (const [method, path] of [
        ['GET', '/mail/rules'],
        ['GET', '/mail/quarantine'],
        ['GET', '/mail/reading'],
        ['GET', '/mail/journal'],
    ] as const) {
        const res = await fetch(`${bareBase}${path}`, {
            method,
            headers: { Authorization: 'Bearer t' },
        });
        assert.strictEqual(res.status, 503, `${method} ${path}`);
        assert.deepStrictEqual(await res.json(), {
            error: 'proactivité indisponible',
        });
    }
    bare.close();

    // ── 500 : les handlers synchrones aussi (pas seulement les async) ─────
    const throwingHandler: MailHandler = {
        mailRules: () => {
            throw new Error('boom rules');
        },
        mailRuleSave: () => {
            throw new Error('boom save');
        },
        mailRuleDelete: () => {
            throw new Error('boom delete');
        },
        mailQuarantine: () => {
            throw new Error('boom quarantine');
        },
        mailJournal: () => {
            throw new Error('boom journal');
        },
    };
    const throwingApp = express();
    throwingApp.use(express.json());
    throwingApp.use('/', mailRoutes(requireAuth as any, throwingHandler));
    const throwing = await listen(throwingApp);
    const throwingBase = `http://127.0.0.1:${throwing.port}`;
    const authed = (path: string, init: RequestInit = {}) =>
        fetch(`${throwingBase}${path}`, {
            ...init,
            headers: { ...init.headers, Authorization: 'Bearer t' },
        });
    assert.strictEqual((await authed('/mail/rules')).status, 500);
    assert.strictEqual(
        (
            await authed('/mail/rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            })
        ).status,
        500,
    );
    assert.strictEqual(
        (await authed('/mail/rules/x', { method: 'DELETE' })).status,
        500,
    );
    assert.strictEqual((await authed('/mail/quarantine')).status, 500);
    assert.strictEqual((await authed('/mail/journal')).status, 500);
    throwing.close();

    console.log('All mail route tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
