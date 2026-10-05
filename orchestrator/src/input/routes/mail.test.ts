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
    const dryRunSeen: Array<{ query?: string; max?: number }> = [];
    const classifySeen: string[][] = [];
    const rulesFile = {
        version: 1,
        rules: [
            {
                id: 'r-user',
                when: { from: 'ami@x.fr' },
                then: { category: 'perso' },
            },
        ],
    };
    let replacedRules: unknown;
    const sendersSeen: Array<{ days?: number; max?: number }> = [];
    const applySeen: Array<{ id: string; max?: number }> = [];
    const statsSeen: Array<number | undefined> = [];

    const handler: MailHandler = {
        mailDryRun: async (query, max) => {
            dryRunSeen.push({ query, max });
            return {
                query,
                total: 0,
                items: [],
                summary: { rule: 0, signal: 0, none: 0, byRule: {} },
            };
        },
        mailClassify: async (mailIds) => {
            classifySeen.push(mailIds);
            return { classified: mailIds.length, skipped: [] };
        },
        mailRulesRaw: () => rulesFile,
        mailSenders: async (days, max) => {
            sendersSeen.push({ days, max });
            return [{ address: 'a@b.fr', count: 1 }];
        },
        mailRuleApply: async (id, max) => {
            applySeen.push({ id, max });
            if (id === 'gone')
                return { applied: 0, archived: 0, refused: 'unknown' };
            if (id === 'neg')
                return { applied: 0, archived: 0, refused: 'not-applicable' };
            return { applied: 3, archived: 2 };
        },
        mailStats: (days) => {
            statsSeen.push(days);
            return {
                days,
                byStage: {},
                byCategory: {},
                quarantine: 0,
                reading: 0,
            };
        },
        mailRulesReplace: (raw) => {
            replacedRules = raw;
            if ((raw as any)?.rules?.[0]?.id === 'bad') {
                return {
                    ok: false,
                    errors: [
                        { index: 0, id: 'bad', error: 'catégorie inconnue' },
                    ],
                };
            }
            return { ok: true, count: (raw as any)?.rules?.length ?? 0 };
        },
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
    const put = (p: string, body: unknown = {}, auth = 'Bearer t') =>
        fetch(`${base}${p}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: auth,
            },
            body: JSON.stringify(body),
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

    // ── 401 sans Bearer (nouvelles routes) ────────────────────────────────
    assert.strictEqual(
        (await post('/mail/rules/dry-run', {}, 'Bearer nope')).status,
        401,
    );

    // ── POST /mail/rules/dry-run : 200, query/max transmis, 400 sur entrée invalide ──
    const dryRunRes = await post('/mail/rules/dry-run', {
        query: 'newer_than:7d',
        max: 100,
    });
    assert.strictEqual(dryRunRes.status, 200);
    assert.deepStrictEqual(await dryRunRes.json(), {
        query: 'newer_than:7d',
        total: 0,
        items: [],
        summary: { rule: 0, signal: 0, none: 0, byRule: {} },
    });
    assert.deepStrictEqual(dryRunSeen[0], { query: 'newer_than:7d', max: 100 });
    assert.strictEqual(
        (await post('/mail/rules/dry-run', {})).status,
        200,
        'query/max optionnels',
    );
    assert.strictEqual(
        (await post('/mail/rules/dry-run', { max: 500 })).status,
        400,
        'max > 200',
    );
    assert.strictEqual(
        (await post('/mail/rules/dry-run', { query: 42 })).status,
        400,
        'query non chaîne',
    );

    // ── POST /mail/triage/classify : 200, 400 sur mailIds absent/vide/trop grand ──
    const classifyRes = await post('/mail/triage/classify', {
        mailIds: ['m1', 'm2'],
    });
    assert.strictEqual(classifyRes.status, 200);
    assert.deepStrictEqual(await classifyRes.json(), {
        classified: 2,
        skipped: [],
    });
    assert.deepStrictEqual(classifySeen[0], ['m1', 'm2']);
    assert.strictEqual(
        (await post('/mail/triage/classify', {})).status,
        400,
        'mailIds manquant',
    );
    assert.strictEqual(
        (await post('/mail/triage/classify', { mailIds: [] })).status,
        400,
        'mailIds vide',
    );
    assert.strictEqual(
        (
            await post('/mail/triage/classify', {
                mailIds: Array.from({ length: 25 }, (_, i) => `m${i}`),
            })
        ).status,
        400,
        'mailIds > 24',
    );
    assert.strictEqual(
        (await post('/mail/triage/classify', { mailIds: [1, 2] })).status,
        400,
        'mailIds non chaînes',
    );

    // ── GET /mail/rules/raw : 200, fichier complet ────────────────────────
    const rawRes = await get('/mail/rules/raw');
    assert.strictEqual(rawRes.status, 200);
    assert.deepStrictEqual(await rawRes.json(), rulesFile);
    assert.strictEqual(
        (await get('/mail/rules/raw', 'Bearer nope')).status,
        401,
    );

    // ── PUT /mail/rules : 200 {ok,count}, 400 {errors} ────────────────────
    const putOk = await put('/mail/rules', {
        version: 1,
        rules: [{ id: 'r-1' }],
    });
    assert.strictEqual(putOk.status, 200);
    assert.deepStrictEqual(await putOk.json(), { ok: true, count: 1 });
    assert.deepStrictEqual(replacedRules, {
        version: 1,
        rules: [{ id: 'r-1' }],
    });
    const putBad = await put('/mail/rules', {
        version: 1,
        rules: [{ id: 'bad' }],
    });
    assert.strictEqual(putBad.status, 400);
    assert.deepStrictEqual(await putBad.json(), {
        errors: [{ index: 0, id: 'bad', error: 'catégorie inconnue' }],
    });

    // ── GET /mail/senders ─────────────────────────────────────────────────
    assert.strictEqual((await get('/mail/senders', 'Bearer nope')).status, 401);
    assert.deepStrictEqual(await (await get('/mail/senders')).json(), [
        { address: 'a@b.fr', count: 1 },
    ]);
    assert.deepStrictEqual(sendersSeen[0], { days: 30, max: 200 });
    await get('/mail/senders?days=7&max=50');
    assert.deepStrictEqual(sendersSeen[1], { days: 7, max: 50 });
    for (const q of ['days=0', 'days=91', 'days=x', 'max=0', 'max=201']) {
        assert.strictEqual((await get(`/mail/senders?${q}`)).status, 400, q);
    }
    assert.strictEqual(sendersSeen.length, 2);

    // ── POST /mail/rules/:id/apply ────────────────────────────────────────
    assert.strictEqual(
        (await post('/mail/rules/r-user/apply', {}, 'Bearer nope')).status,
        401,
    );
    const applyRes = await post('/mail/rules/r-user/apply', { max: 20 });
    assert.strictEqual(applyRes.status, 200);
    assert.deepStrictEqual(await applyRes.json(), { applied: 3, archived: 2 });
    assert.deepStrictEqual(applySeen[0], { id: 'r-user', max: 20 });
    assert.strictEqual((await post('/mail/rules/gone/apply')).status, 404);
    const notApplicable = await post('/mail/rules/neg/apply');
    assert.strictEqual(notApplicable.status, 400);
    assert.ok((await notApplicable.json()).error);
    assert.strictEqual(
        (await post('/mail/rules/r-user/apply', { max: 500 })).status,
        400,
    );

    // ── GET /mail/stats ───────────────────────────────────────────────────
    assert.strictEqual((await get('/mail/stats', 'Bearer nope')).status, 401);
    assert.strictEqual((await get('/mail/stats')).status, 200);
    assert.strictEqual(statsSeen[0], 7);
    await get('/mail/stats?days=30');
    assert.strictEqual(statsSeen[1], 30);
    assert.strictEqual((await get('/mail/stats?days=100')).status, 400);

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
        ['POST', '/mail/rules/dry-run'],
        ['POST', '/mail/triage/classify'],
        ['GET', '/mail/rules/raw'],
        ['PUT', '/mail/rules'],
        ['GET', '/mail/senders'],
        ['POST', '/mail/rules/x/apply'],
        ['GET', '/mail/stats'],
    ] as const) {
        const res = await fetch(`${bareBase}${path}`, {
            method,
            headers: {
                Authorization: 'Bearer t',
                'Content-Type': 'application/json',
            },
            body:
                method === 'POST' || method === 'PUT'
                    ? JSON.stringify(
                          path === '/mail/triage/classify'
                              ? { mailIds: ['m1'] }
                              : {},
                      )
                    : undefined,
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
        mailDryRun: async () => {
            throw new Error('boom dry-run');
        },
        mailClassify: async () => {
            throw new Error('boom classify');
        },
        mailRulesRaw: () => {
            throw new Error('boom raw');
        },
        mailRulesReplace: () => {
            throw new Error('boom replace');
        },
        mailSenders: async () => {
            throw new Error('boom senders');
        },
        mailRuleApply: async () => {
            throw new Error('boom apply');
        },
        mailStats: () => {
            throw new Error('boom stats');
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
    assert.strictEqual(
        (
            await authed('/mail/rules/dry-run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            })
        ).status,
        500,
    );
    assert.strictEqual(
        (
            await authed('/mail/triage/classify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailIds: ['m1'] }),
            })
        ).status,
        500,
    );
    assert.strictEqual((await authed('/mail/rules/raw')).status, 500);
    assert.strictEqual(
        (
            await authed('/mail/rules', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version: 1, rules: [] }),
            })
        ).status,
        500,
    );
    assert.strictEqual((await authed('/mail/senders')).status, 500);
    assert.strictEqual((await authed('/mail/stats')).status, 500);
    assert.strictEqual(
        (await authed('/mail/rules/x/apply', { method: 'POST' })).status,
        500,
    );
    throwing.close();

    console.log('All mail route tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
