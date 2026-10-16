// POST /floating/preview : liste effet → cible fusionnée en une boucle.
import assert from 'assert';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-fx-routes-'));
process.env.YUI_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { effectRoutes } = require('./effects');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
    animationManager,
} = require('../../orchestrator/animation/animationManager');

const requireAuth = (req: any, res: any, next: any) =>
    req.headers.authorization === 'Bearer t'
        ? next()
        : res.status(401).json({ error: 'unauthorized' });

async function run(): Promise<void> {
    const writes: { target: string; color: string }[] = [];
    const deviceHandler = async (tool: string, args: any) => {
        if (tool === 'list_lights') {
            return [
                { name: 'Lampe Sol', room: 'Salon' },
                { name: 'Plafond', room: 'Salon' },
                { name: 'Chevet', room: 'Chambre' },
            ];
        }
        if (tool === 'set_lights') writes.push(args);
        return null;
    };
    const app = express();
    app.use(express.json());
    app.use('/', effectRoutes(requireAuth, deviceHandler));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const post = (body: unknown, auth = true) =>
        fetch(`http://127.0.0.1:${port}/floating/preview`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(auth ? { Authorization: 'Bearer t' } : {}),
            },
            body: JSON.stringify(body),
        });
    try {
        assert.strictEqual((await post({ effects: [] }, false)).status, 401);
        const empty = await post({ effects: [] });
        assert.strictEqual(empty.status, 400);
        assert.ok(((await empty.json()) as any).error);
        const none = await post({
            effects: [{ effectId: 'inexistant', target: 'Salon' }],
        });
        assert.strictEqual(none.status, 400);

        // Seeds : aurora (vert/bleu) sur Chambre, braise (rouge) sur Lampe Sol
        const ok = await post({
            effects: [
                { effectId: 'aurora', target: 'Chambre' },
                { effectId: 'braise', target: 'Lampe Sol' },
            ],
        });
        assert.strictEqual(ok.status, 200);
        assert.deepStrictEqual(await ok.json(), { success: true });
        await new Promise((r) => setTimeout(r, 50));
        const targets = writes.map((w) => w.target).sort();
        assert.deepStrictEqual(targets, ['Chevet', 'Lampe Sol']);
        const sol = writes.find((w) => w.target === 'Lampe Sol')!;
        assert.strictEqual(sol.color.toLowerCase(), '#7f1d1d');
        const chevet = writes.find((w) => w.target === 'Chevet')!;
        // Chevet suit aurora (décalé par le stagger) — jamais la braise
        assert.notStrictEqual(chevet.color.toLowerCase(), '#7f1d1d');
        assert.ok(/^#[0-9a-f]{6}$/i.test(chevet.color));
    } finally {
        await animationManager.stopAll();
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('effects routes: ok');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
