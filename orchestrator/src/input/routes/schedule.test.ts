// Routes /schedule : CRUD semaine/exceptions et plan des jours (agenda en panne
// ou congé lu).
import assert from 'assert';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-schedule-routes-'));
process.env.YUI_DATA_DIR = tmp;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scheduleRoutes } = require('./schedule');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addDays, localYmd } = require('../../orchestrator/schedule/dayPlan');
const today: string = localYmd(new Date());
const leaveDay: string = addDays(today, 3);

const requireAuth = (req: any, res: any, next: any) =>
    req.headers.authorization === 'Bearer t'
        ? next()
        : res.status(401).json({ error: 'unauthorized' });

async function serve(toolsHandler?: unknown) {
    const app = express();
    app.use(express.json());
    app.use('/', scheduleRoutes(requireAuth, toolsHandler));
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

async function run(): Promise<void> {
    const down = {
        callWithStatus: async () => {
            throw new Error('calendar down');
        },
    };
    const { server, call } = await serve(down);
    try {
        assert.strictEqual(
            (await call('GET', '/schedule', undefined, false)).status,
            401,
        );

        const s = (await (await call('GET', '/schedule')).json()) as any;
        assert.strictEqual(Object.keys(s.week).length, 7);
        assert.ok(Object.values(s.week).every((d: any) => d.mode === 'remote'));

        const bad = await call('PUT', '/schedule/week', {
            week: { '1': { mode: 'x' } },
        });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(typeof ((await bad.json()) as any).error, 'string');

        const week: Record<string, unknown> = {};
        for (const k of ['0', '1', '2', '3', '4', '5', '6'])
            week[k] = { mode: 'remote' };
        week['1'] = { mode: 'onsite' };
        const ok = await call('PUT', '/schedule/week', { week });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(((await ok.json()) as any).week['1'].leave, '08:30');

        const created = await call('POST', '/schedule/exceptions', {
            date: '2099-01-05',
            mode: 'off',
        });
        assert.strictEqual(created.status, 200);
        assert.strictEqual(
            ((await created.json()) as any).exceptions.length,
            1,
        );
        assert.strictEqual(
            (
                await call('POST', '/schedule/exceptions', {
                    date: '2000-01-01',
                    mode: 'off',
                })
            ).status,
            400,
        );
        assert.strictEqual(
            (await call('DELETE', '/schedule/exceptions/2099-01-05')).status,
            200,
        );
        const gone = await call('DELETE', '/schedule/exceptions/2099-01-05');
        assert.strictEqual(gone.status, 404);
        assert.strictEqual(
            ((await gone.json()) as any).error,
            'Exception introuvable',
        );

        assert.strictEqual(
            (await call('GET', '/schedule/plan?days=40')).status,
            400,
        );
        assert.strictEqual(
            (await call('GET', '/schedule/plan?days=0')).status,
            400,
        );
        assert.strictEqual(
            (await call('GET', '/schedule/plan?from=demain')).status,
            400,
        );

        // agenda en panne : la semaine type sort quand même
        const plan = await call('GET', '/schedule/plan?from=2026-11-09&days=3');
        assert.strictEqual(plan.status, 200);
        const pj = (await plan.json()) as any;
        assert.strictEqual(pj.calendarOk, false);
        assert.strictEqual(pj.plans.length, 3);
        assert.strictEqual(pj.plans[0].mode, 'onsite'); // lundi 9
        assert.strictEqual(pj.plans[2].reason, 'ferie'); // 11 novembre

        const def = (await (await call('GET', '/schedule/plan')).json()) as any;
        assert.strictEqual(def.plans.length, 7);
    } finally {
        server.close();
    }

    // congé lu dans l'agenda
    const withLeave = {
        callWithStatus: async (name: string) => {
            assert.strictEqual(name, 'get_schedule');
            return {
                result: JSON.stringify({
                    days: [
                        {
                            date: leaveDay,
                            events: [
                                {
                                    id: 'x',
                                    title: 'Congés',
                                    all_day: true,
                                    date: leaveDay,
                                    calendar: 'Calendrier',
                                },
                            ],
                        },
                    ],
                }),
                isError: false,
            };
        },
    };
    const b = await serve(withLeave);
    try {
        const r = (await (
            await b.call('GET', `/schedule/plan?from=${leaveDay}&days=2`)
        ).json()) as any;
        assert.strictEqual(r.calendarOk, true);
        assert.strictEqual(r.plans[0].reason, 'conge');
        assert.strictEqual(r.plans[0].label, 'Congés');
        assert.strictEqual(r.plans[1].reason, 'semaine');

        // hors de la fenêtre lue dans l'agenda : congés non vérifiés
        const far = (await (
            await b.call('GET', '/schedule/plan?from=2099-01-05&days=2')
        ).json()) as any;
        assert.strictEqual(far.calendarOk, false);
        assert.strictEqual(far.plans.length, 2);
        const past = (await (
            await b.call(
                'GET',
                `/schedule/plan?from=${addDays(today, -3)}&days=2`,
            )
        ).json()) as any;
        assert.strictEqual(past.calendarOk, false);
        const edge = (await (
            await b.call('GET', `/schedule/plan?from=${today}&days=31`)
        ).json()) as any;
        assert.strictEqual(edge.calendarOk, true);

        // disque en lecture seule : la purge échoue, les routes répondent quand même
        const cfg = path.join(tmp, 'config');
        fs.writeFileSync(
            path.join(cfg, 'schedule.json'),
            JSON.stringify({
                week: {},
                exceptions: [{ date: '2000-01-03', mode: 'off' }],
            }),
        );
        fs.chmodSync(cfg, 0o555);
        try {
            const ro = await b.call('GET', '/schedule/plan?days=2');
            assert.strictEqual(ro.status, 200);
            assert.strictEqual(((await ro.json()) as any).plans.length, 2);
            const ros = await b.call('GET', '/schedule');
            assert.strictEqual(ros.status, 200);
            assert.strictEqual(
                ((await ros.json()) as any).exceptions.length,
                0,
            );
        } finally {
            fs.chmodSync(cfg, 0o755);
        }
    } finally {
        b.server.close();
    }

    // erreur MCP signalée (isError) : calendarOk false, pas de 500
    const isErr = {
        callWithStatus: async () => ({ result: 'Error: quota', isError: true }),
    };
    const c = await serve(isErr);
    try {
        const r = await c.call('GET', '/schedule/plan?from=2026-11-30&days=1');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(((await r.json()) as any).calendarOk, false);
    } finally {
        c.server.close();
    }
    console.log('schedule routes ok');
}
run().catch((e) => {
    console.error(e);
    process.exit(1);
});
