import assert from 'assert';
import express from 'express';
import http from 'http';
import { configRoutes } from './config';
import type { ProactiveHandler } from '../InputSource';

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

function mount(proactiveHandler: ProactiveHandler): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', configRoutes(requireAuth as any, undefined, proactiveHandler));
    return app;
}

async function run(): Promise<void> {
    const facts = [
        {
            subject: 'agenda:today',
            text: 'Rendez-vous à 14h',
            importance: 'utile' as const,
            at: Date.now(),
            nature: 'info' as const,
            fingerprint: 'abc',
        },
    ];
    let receivedScope: string | undefined;
    const handler: ProactiveHandler = {
        reload: () => {},
        brief: async (scope) => {
            receivedScope = scope;
            return { text: 'Voilà le point.', fallback: false };
        },
        briefPreview: (scope) => {
            receivedScope = scope;
            return facts;
        },
    };
    const { port, close } = await listen(mount(handler));
    const post = (body: unknown, auth = 'Bearer t') =>
        fetch(`http://127.0.0.1:${port}/proactive/brief`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: auth,
            },
            body: JSON.stringify(body),
        });
    const getPreview = (qs: string, auth = 'Bearer t') =>
        fetch(`http://127.0.0.1:${port}/proactive/brief/preview${qs}`, {
            headers: { Authorization: auth },
        });

    // 200 — passe le scope au moteur, restitue text + fallback.
    const ok = await post({ scope: 'today' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(await ok.json(), {
        text: 'Voilà le point.',
        fallback: false,
    });
    assert.strictEqual(receivedScope, 'today');

    // Sans scope — passé tel quel (undefined) au moteur, pas de 400.
    const okDefault = await post({});
    assert.strictEqual(okDefault.status, 200);
    assert.strictEqual(receivedScope, undefined);

    // Preview — les facts bruts, sans effet de bord côté moteur.
    const preview = await getPreview('?scope=pending');
    assert.strictEqual(preview.status, 200);
    assert.deepStrictEqual(await preview.json(), { facts });
    assert.strictEqual(receivedScope, 'pending');

    // 401 — sans bearer.
    assert.strictEqual((await post({}, 'Bearer nope')).status, 401);
    assert.strictEqual((await getPreview('', 'Bearer nope')).status, 401);

    // 400 — scope inconnu, ni pour la route ni pour le moteur.
    const bad = await post({ scope: 'plus-tard' });
    assert.strictEqual(bad.status, 400);
    assert.ok((await bad.json()).error);
    const badPreview = await getPreview('?scope=plus-tard');
    assert.strictEqual(badPreview.status, 400);

    close();

    // 503 — handler sans brief/briefPreview (proactivité pas câblée).
    const bare: ProactiveHandler = { reload: () => {} };
    const { port: port2, close: close2 } = await listen(mount(bare));
    const unavailable = await fetch(
        `http://127.0.0.1:${port2}/proactive/brief`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer t',
            },
            body: JSON.stringify({}),
        },
    );
    assert.strictEqual(unavailable.status, 503);
    const unavailablePreview = await fetch(
        `http://127.0.0.1:${port2}/proactive/brief/preview`,
        { headers: { Authorization: 'Bearer t' } },
    );
    assert.strictEqual(unavailablePreview.status, 503);
    close2();

    // 500 — le moteur jette, la route répond sans laisser fuiter le rejet.
    const failing: ProactiveHandler = {
        reload: () => {},
        brief: async () => {
            throw new Error('boom');
        },
    };
    const { port: port3, close: close3 } = await listen(mount(failing));
    const failed = await fetch(`http://127.0.0.1:${port3}/proactive/brief`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer t',
        },
        body: JSON.stringify({}),
    });
    assert.strictEqual(failed.status, 500);
    assert.deepStrictEqual(await failed.json(), { error: 'boom' });
    close3();

    console.log('All proactive brief route tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
