import assert from 'assert';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { mailRoutes, type MailHandler } from './mail';
import {
    BadRequestError,
    NotFoundError,
} from '../../orchestrator/proactive/mail/errors';
import { SenderStore } from '../../orchestrator/proactive/mail/senders';
import {
    addKeepSender,
    addSpamSender,
} from '../../orchestrator/proactive/mail/senderOps';

process.on('unhandledRejection', () => {
    console.error('unhandled rejection');
    process.exit(1);
});

const requireAuth = (req: any, res: any, next: any) =>
    req.headers.authorization === 'Bearer t'
        ? next()
        : res.status(401).json({ error: 'unauthorized' });

async function serve(h: MailHandler | undefined) {
    const app = express();
    app.use(express.json());
    app.use('/', mailRoutes(requireAuth as any, h));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const call = async (
        method: string,
        url: string,
        body?: unknown,
        auth = 'Bearer t',
    ) => {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: {
                authorization: auth,
                'content-type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { call, close: () => server.close() };
}

async function run(): Promise<void> {
    // Vrai SenderStore (fichier temporaire) + faux courier : la route
    // « keep » doit créer l'expéditeur ET oublier l'inconnu.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-routes-'));
    const senders = new SenderStore(path.join(dir, 'senders.json'));
    let unknown = [
        { address: 'a@x.fr' },
        { address: 'b@shop.com' },
        { address: 'c@shop.com' },
    ];
    const courier = {
        unknown: () => unknown as any,
        forgetUnknown: (a: string) => {
            unknown = unknown.filter((u) => u.address !== a);
        },
    };
    const seen: any = {};
    const h: MailHandler = {
        mailSendersFile: () => senders.file(),
        mailSendersReplace: (raw) => senders.replace(raw),
        mailSenderKeep: (i) => addKeepSender(senders, courier, i, 1),
        mailSenderSpam: (m) => addSpamSender(senders, courier, m, 1),
        mailSenderDelete: (id) => senders.remove(id),
        mailSenderApply: async (id, max) => {
            seen.apply = { id, max };
            if (id === 'zz')
                throw new NotFoundError('Expéditeur introuvable : zz');
            if (id === 'sp')
                throw new BadRequestError(
                    "le rangement rétroactif n'existe que pour les expéditeurs à garder",
                );
            return { matched: 1, applied: 1 };
        },
        mailUnknown: () => unknown,
        mailOrders: () => [],
        mailOrderAdd: (text, days) => {
            seen.order = { text, days };
            return { id: 'o-1', text };
        },
        mailOrderDelete: (id) => id === 'o-1',
        mailDryRun: async (query, max) => {
            seen.dry = { query, max };
            return [];
        },
        mailJournal: (limit, scope) => {
            seen.journal = { limit, scope };
            return [];
        },
        mailStats: (days) => {
            seen.stats = days;
            return {};
        },
        mailScan: async () => ({ scanned: 0 }),
        mailMigration: () => seen.migration ?? null,
    };
    const { call, close } = await serve(h);

    // auth par route
    assert.strictEqual(
        (await call('GET', '/mail/senders', undefined, 'x')).status,
        401,
    );
    assert.strictEqual((await call('GET', '/mail/senders')).status, 200);

    // keep : 400 sur match court / nom avec "/" / nom trop long / read invalide
    for (const body of [
        { match: 'a', name: 'Ok' },
        { match: '  ', name: 'Ok' },
        { match: 'a@x.fr', name: 'a/b' },
        { match: 'a@x.fr', name: 'x'.repeat(41) },
        { match: 'a@x.fr', name: '   ' },
        { match: 'a@x.fr', name: 'Ok', read: 'bof' },
    ]) {
        const r = await call('POST', '/mail/senders/keep', body);
        assert.strictEqual(r.status, 400, JSON.stringify(body));
        assert.ok(r.body.error);
    }
    assert.strictEqual(senders.keep().length, 0, 'rien créé sur 400');

    // règles invalides : 400 et rien d'écrit
    for (const rules of [
        [{ subject: '(', read: true }],
        'x',
        [{ subject: 'a' }],
    ]) {
        const bad = await call('POST', '/mail/senders/keep', {
            match: 'z@z.fr',
            name: 'Z',
            rules,
        });
        assert.strictEqual(bad.status, 400, JSON.stringify(rules));
    }
    assert.strictEqual(
        (
            await call('POST', '/mail/senders/keep', {
                match: 'z@z.fr',
                name: 'Z',
                readDefault: 'oui',
            })
        ).status,
        400,
    );
    assert.strictEqual(senders.keep().length, 0, 'rien écrit');

    // keep : 201, trim, inconnu oublié
    let r = await call('POST', '/mail/senders/keep', {
        match: '  a@x.fr ',
        name: ' Banque ',
        read: 'always',
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.match, 'a@x.fr');
    assert.strictEqual(r.body.name, 'Banque');
    assert.deepStrictEqual(
        unknown.map((u) => u.address),
        ['b@shop.com', 'c@shop.com'],
    );
    const keepId = r.body.id;

    // spam sur un domaine : tous les inconnus du domaine oubliés
    r = await call('POST', '/mail/senders/spam', { match: '@shop.com' });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(unknown, []);
    assert.strictEqual(
        (await call('POST', '/mail/senders/spam', { match: 'x' })).status,
        400,
    );
    const spamId = r.body.id;

    // même match en spam après keep : change de liste
    await call('POST', '/mail/senders/spam', { match: 'a@x.fr' });
    assert.strictEqual(senders.keep().length, 0);
    assert.strictEqual(senders.spam().length, 2);

    // domaine : x.fr n'oublie pas a@notx.fr
    unknown = [{ address: 'a@notx.fr' }, { address: 'b@x.fr' }];
    await call('POST', '/mail/senders/spam', { match: 'x.fr' });
    assert.deepStrictEqual(
        unknown.map((u) => u.address),
        ['a@notx.fr'],
    );

    // un échec d'ajout ne supprime rien : spam présent, keep invalide
    await call('POST', '/mail/senders/spam', { match: 'dup@y.fr' });
    const before = senders.spam().length;
    await call('POST', '/mail/senders/keep', {
        match: 'dup@y.fr',
        name: 'a/b',
    });
    await call('POST', '/mail/senders/keep', {
        match: 'dup@y.fr',
        name: 'Y',
        rules: 'x',
    });
    assert.strictEqual(senders.spam().length, before);
    // ... et un ajout réussi déplace de spam vers keep
    await call('POST', '/mail/senders/keep', { match: 'dup@y.fr', name: 'Y' });
    assert.strictEqual(senders.spam().length, before - 1);
    assert.ok(senders.keep().some((k) => k.match === 'dup@y.fr'));
    senders.remove(senders.keep().find((k) => k.match === 'dup@y.fr')!.id);

    // match trop large : domaine grand public nu ou sans « . » ni « @ » → 400
    for (const [path, body] of [
        ['/mail/senders/spam', { match: 'gmail.com' }],
        ['/mail/senders/spam', { match: '@Gmail.com' }],
        ['/mail/senders/spam', { match: 'promo' }],
        ['/mail/senders/keep', { match: 'outlook.com', name: 'O' }],
        ['/mail/senders/keep', { match: 'bot', name: 'B' }],
    ] as const) {
        const nb = senders.keep().length + senders.spam().length;
        const bad = await call('POST', path, body);
        assert.strictEqual(bad.status, 400, JSON.stringify(body));
        assert.strictEqual(
            senders.keep().length + senders.spam().length,
            nb,
            'rien écrit',
        );
        if (body.match.toLowerCase().includes('.com')) {
            assert.ok(
                /grand public/.test(bad.body.error),
                JSON.stringify(bad.body),
            );
        }
    }
    // une adresse précise sur un domaine grand public passe
    r = await call('POST', '/mail/senders/spam', { match: 'jean@gmail.com' });
    assert.strictEqual(r.status, 201);
    senders.remove(r.body.id);

    // delete
    assert.strictEqual(
        (await call('DELETE', `/mail/senders/${spamId}`)).status,
        204,
    );
    assert.strictEqual(
        (await call('DELETE', '/mail/senders/nope')).status,
        404,
    );
    assert.ok(keepId);

    // PUT : fichier invalide → 400, valide → 200
    assert.strictEqual(
        (await call('PUT', '/mail/senders', { version: 2 })).status,
        400,
    );
    r = await call('PUT', '/mail/senders', { version: 3, keep: [], spam: [] });
    assert.strictEqual(r.status, 200);

    // apply : défaut 100, > 200 rejeté, id inconnu → 404
    await call('POST', '/mail/senders/k-1/apply', {});
    assert.deepStrictEqual(seen.apply, { id: 'k-1', max: 100 });
    assert.strictEqual(
        (await call('POST', '/mail/senders/k-1/apply', { max: 201 })).status,
        400,
    );
    assert.strictEqual(
        (await call('POST', '/mail/senders/zz/apply', {})).status,
        404,
    );
    const spApply = await call('POST', '/mail/senders/sp/apply', {});
    assert.strictEqual(spApply.status, 400);
    assert.ok(/expéditeurs à garder/.test(spApply.body.error));

    // ordres : days > 60 rejeté (400, pas clampé), défaut 14, texte requis
    assert.strictEqual(
        (await call('POST', '/mail/orders', { text: 'colis', days: 61 }))
            .status,
        400,
    );
    assert.strictEqual(
        (await call('POST', '/mail/orders', { text: 'colis', days: 0 })).status,
        400,
    );
    assert.strictEqual(
        (await call('POST', '/mail/orders', { text: ' ' })).status,
        400,
    );
    r = await call('POST', '/mail/orders', { text: ' colis ' });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(seen.order, { text: 'colis', days: 14 });
    assert.strictEqual((await call('DELETE', '/mail/orders/o-1')).status, 204);
    assert.strictEqual((await call('DELETE', '/mail/orders/o-9')).status, 404);

    // dry-run : max ≤ 100
    await call('POST', '/mail/dry-run', {});
    assert.deepStrictEqual(seen.dry, { query: undefined, max: 100 });
    assert.strictEqual(
        (await call('POST', '/mail/dry-run', { max: 101 })).status,
        400,
    );

    // journal : défaut 50, plafond 200, scope
    await call('GET', '/mail/journal');
    assert.deepStrictEqual(seen.journal, { limit: 50, scope: undefined });
    await call('GET', '/mail/journal?limit=999&scope=actions');
    assert.deepStrictEqual(seen.journal, { limit: 200, scope: 'actions' });

    // stats : 1-90, défaut 7
    await call('GET', '/mail/stats');
    assert.strictEqual(seen.stats, 7);
    assert.strictEqual((await call('GET', '/mail/stats?days=91')).status, 400);
    assert.strictEqual((await call('GET', '/mail/stats?days=0')).status, 400);

    assert.strictEqual((await call('POST', '/mail/scan')).status, 200);
    assert.strictEqual((await call('GET', '/mail/migration')).status, 404);
    seen.migration = { migrated: 3 };
    assert.deepStrictEqual((await call('GET', '/mail/migration')).body, {
        migrated: 3,
    });
    close();

    // sans handler : 503
    const none = await serve(undefined);
    for (const [m, u] of [
        ['GET', '/mail/senders'],
        ['POST', '/mail/senders/keep'],
        ['GET', '/mail/orders'],
        ['POST', '/mail/scan'],
        ['GET', '/mail/stats'],
    ]) {
        assert.strictEqual(
            (await none.call(m, u, m === 'GET' ? undefined : {})).status,
            503,
            u,
        );
    }
    none.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('mail routes tests OK');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
