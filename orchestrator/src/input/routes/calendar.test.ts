// Routes /calendar : règles d'agenda (CRUD, aperçu) et vue agenda 14 jours.
import assert from 'assert';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-calendar-routes-'));
process.env.YUI_DATA_DIR = tmp;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { calendarRoutes } = require('./calendar');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addDays, localYmd } = require('../../orchestrator/schedule/dayPlan');
const today: string = localYmd(new Date());

const requireAuth = (req: any, res: any, next: any) =>
    req.headers.authorization === 'Bearer t'
        ? next()
        : res.status(401).json({ error: 'unauthorized' });

async function serve(toolsHandler?: unknown) {
    const app = express();
    app.use(express.json());
    app.use('/', calendarRoutes(requireAuth, toolsHandler));
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

const RULE = {
    title: 'Test',
    kind: 'last-workday-month',
    allDay: true,
    calendarId: 'primary',
};
const rulesFile = () => path.join(tmp, 'config', 'calendar-rules.json');

async function run(): Promise<void> {
    const payload = {
        days: [
            {
                date: today,
                events: [
                    {
                        id: 'w1',
                        title: 'Semaine 48',
                        date: today,
                        all_day: true,
                        calendar: 'Numéros de semaine',
                    },
                    {
                        id: 'm1',
                        title: 'Point équipe',
                        date: today,
                        start: '10:00',
                        end: '10:30',
                        all_day: false,
                        calendar: 'Pro',
                        calendar_id: 'cal-pro',
                        meet_link: 'https://meet.google.com/x',
                    },
                    {
                        id: 'l1',
                        title: 'Congés',
                        date: addDays(today, -3),
                        end_date: addDays(today, 2),
                        all_day: true,
                        calendar: 'Pro',
                    },
                    {
                        id: 'l2',
                        title: 'Séminaire',
                        date: addDays(today, 1),
                        end_date: addDays(today, 3),
                        all_day: true,
                        calendar: 'Pro',
                    },
                    {
                        id: 'a1',
                        title: 'Férié',
                        date: today,
                        all_day: true,
                        calendar: 'Pro',
                        yui_rule: 'rule-1',
                    },
                ],
            },
        ],
    };
    let fail = false;
    let empty = false;
    const handler = {
        callWithStatus: async (name: string, args: any) => {
            assert.strictEqual(name, 'get_schedule');
            assert.strictEqual(args.startDate, today);
            assert.strictEqual(args.endDate, addDays(today, 13));
            assert.strictEqual(args.maxResults, 250);
            if (empty)
                return {
                    result: JSON.stringify({
                        events: [],
                        start: args.startDate,
                        end: args.endDate,
                    }),
                    isError: false,
                };
            return fail
                ? { result: 'boom', isError: true }
                : { result: JSON.stringify(payload), isError: false };
        },
    };
    const { server, call } = await serve(handler);
    try {
        assert.strictEqual(
            (await call('GET', '/calendar/rules', undefined, false)).status,
            401,
        );

        const bad = await call('POST', '/calendar/rules', { title: '' });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(typeof ((await bad.json()) as any).error, 'string');

        const before = fs.existsSync(rulesFile());
        const prev = await call('POST', '/calendar/rules/preview', RULE);
        const prevBody = (await prev.json()) as any;
        if (prev.status !== 200) throw new Error(JSON.stringify(prevBody));
        assert.strictEqual(prevBody.dates.length, 6);
        assert.strictEqual(fs.existsSync(rulesFile()), before);

        const rule = RULE;
        const created = await call('POST', '/calendar/rules', rule);
        const cBody = (await created.json()) as any;
        if (created.status !== 201) throw new Error(JSON.stringify(cBody));
        const id = cBody.rule.id;
        const list = (await (
            await call('GET', '/calendar/rules')
        ).json()) as any;
        assert.strictEqual(list.rules.length, 1);
        assert.ok('sync' in list);

        const put = await call('PUT', `/calendar/rules/${id}`, {
            ...rule,
            title: 'Test2',
        });
        assert.strictEqual(put.status, 200);
        assert.strictEqual(((await put.json()) as any).rule.title, 'Test2');
        const put404 = await call('PUT', '/calendar/rules/nope', rule);
        assert.strictEqual(put404.status, 404);
        assert.strictEqual(
            ((await put404.json()) as any).error,
            'Règle introuvable',
        );

        const sync = await call('POST', '/calendar/rules/sync');
        assert.strictEqual(sync.status, 503);

        assert.strictEqual(
            (await call('DELETE', `/calendar/rules/${id}`)).status,
            200,
        );
        assert.strictEqual(
            (await call('DELETE', `/calendar/rules/${id}`)).status,
            404,
        );

        // Fichier de règles illisible → 500 {error}, fichier intact
        fs.writeFileSync(rulesFile(), '{cassé');
        const broken = await call('GET', '/calendar/rules');
        assert.strictEqual(broken.status, 500);
        assert.strictEqual(
            typeof ((await broken.json()) as any).error,
            'string',
        );
        const brokenPost = await call('POST', '/calendar/rules', RULE);
        assert.strictEqual(brokenPost.status, 500);
        assert.strictEqual(
            (await call('PUT', '/calendar/rules/x', RULE)).status,
            500,
        );
        assert.strictEqual(
            (await call('DELETE', '/calendar/rules/x')).status,
            500,
        );
        assert.strictEqual(fs.readFileSync(rulesFile(), 'utf8'), '{cassé');
        fs.rmSync(rulesFile());

        const ag = (await (
            await call('GET', '/calendar/agenda')
        ).json()) as any;
        assert.strictEqual(ag.calendarOk, true);
        assert.strictEqual(ag.days.length, 14);
        assert.strictEqual(ag.days[0].date, today);
        assert.strictEqual(ag.days[13].date, addDays(today, 13));
        const evs = ag.days[0].events;
        const m = evs.find((x: any) => x.id === 'm1');
        assert.strictEqual(evs.length, 3);
        assert.strictEqual(evs[evs.length - 1].id, 'm1'); // horaires après journée entière
        assert.strictEqual(
            evs.find((x: any) => x.id === 'a1').ruleId,
            'rule-1',
        );
        assert.strictEqual(m.mode, 'visio');
        assert.strictEqual(m.end, '10:30');
        assert.strictEqual(m.calendarId, 'cal-pro');
        const where = (id: string) =>
            ag.days
                .map((d: any, i: number) =>
                    d.events.some((x: any) => x.id === id) ? i : -1,
                )
                .filter((i: number) => i >= 0);
        assert.deepStrictEqual(where('l1'), [0, 1, 2]);
        assert.deepStrictEqual(where('l2'), [1, 2, 3]);
        assert.strictEqual(
            ag.days[0].events.find((x: any) => x.id === 'l1').date,
            addDays(today, -3),
        );
        assert.strictEqual(
            (await call('GET', '/calendar/agenda?days=40')).status,
            400,
        );

        // Fenêtre vide : get_schedule rend {events: [], start, end} sans `days`
        empty = true;
        const none = (await (
            await call('GET', '/calendar/agenda')
        ).json()) as any;
        assert.strictEqual(none.calendarOk, true, 'fenêtre vide = agenda OK');
        assert.strictEqual(none.days.length, 14);
        assert.ok(none.days.every((d: any) => d.events.length === 0));
        empty = false;

        fail = true;
        const down = (await (
            await call('GET', '/calendar/agenda')
        ).json()) as any;
        assert.strictEqual(down.calendarOk, false);
        assert.strictEqual(down.days.length, 14);
        assert.ok(down.days.every((d: any) => d.events.length === 0));
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('calendar routes OK');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
