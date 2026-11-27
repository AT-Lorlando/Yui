// Service de synchronisation des règles d'agenda (callTool simulé, sans timers).
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-calendar-sync-'));
process.env.YUI_DATA_DIR = tmp;
process.env.YUI_INSTANCE = 'me';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CalendarRulesSync } = require('./sync');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeRule } = require('./model');

const today = '2026-11-27';
const now = () => new Date(2026, 10, 27, 10, 0);
const statusFile = path.join(tmp, 'state', 'calendar-rules-sync.json');

type Call = { name: string; args: Record<string, unknown> };

function fakeTool(opts: {
    events?: unknown[];
    listFails?: boolean;
    failCreateOn?: string;
    listDelayMs?: number;
    scanned?: string[];
    deleteError?: string;
}) {
    const calls: Call[] = [];
    const callTool = async (
        name: string,
        args: Record<string, unknown> = {},
    ) => {
        calls.push({ name, args });
        if (name === 'list_tagged_events') {
            if (opts.listDelayMs)
                await new Promise((r) => setTimeout(r, opts.listDelayMs));
            if (opts.listFails) throw new Error('quota dépassé');
            return {
                events: opts.events ?? [],
                scanned: opts.scanned ?? ['primary'],
            };
        }
        if (name === 'delete_event' && opts.deleteError)
            throw new Error(opts.deleteError);
        if (name === 'create_event') {
            const pp = args.privateProperties as Record<string, string>;
            if (opts.failCreateOn && pp.yuiDate === opts.failCreateOn)
                throw new Error('Google 500');
            return { id: `new-${pp.yuiDate}` };
        }
        return { ok: true };
    };
    return { calls, callTool };
}

const allDayRule = normalizeRule(
    {
        id: 'facture',
        title: 'Facture',
        kind: 'last-workday-month',
        start: today,
        until: '2026-12-31',
    },
    { today },
);
const lateRule = normalizeRule(
    {
        id: 'tard',
        title: 'Sauvegarde',
        kind: 'day-of-month',
        day: 30,
        shift: 'none',
        allDay: false,
        time: '23:30',
        durationMin: 60,
        start: today,
        until: '2026-12-31',
    },
    { today },
);

async function main() {
    // 1. Échec du listing → aucune écriture, ok:false
    {
        const { calls, callTool } = fakeTool({ listFails: true });
        const s = new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [allDayRule],
        });
        const st = await s.runOnce();
        assert.strictEqual(st.ok, false);
        assert.match(st.error, /quota/);
        assert.strictEqual(s.status().ok, false);
        assert.deepStrictEqual(
            calls.map((c) => c.name),
            ['list_tagged_events'],
        );
        assert.deepStrictEqual(calls[0].args, {
            startDate: today,
            endDate: '2027-02-27',
        });
        const persisted = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        assert.strictEqual(persisted.ok, false);
    }

    // 1b. Réponse de listing malformée → abandon aussi
    {
        const calls: Call[] = [];
        const callTool = async (
            name: string,
            args: Record<string, unknown> = {},
        ) => {
            calls.push({ name, args });
            return 'Error: boom';
        };
        const s = new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [allDayRule],
        });
        const st = await s.runOnce();
        assert.strictEqual(st.ok, false);
        assert.strictEqual(calls.length, 1);
    }

    // 2. Un échec de création n'arrête pas les suivantes ; journée entière
    {
        const { calls, callTool } = fakeTool({ failCreateOn: '2026-11-30' });
        const s = new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [allDayRule],
        });
        const st = await s.runOnce();
        const creates = calls.filter((c) => c.name === 'create_event');
        assert.strictEqual(creates.length, 2);
        assert.strictEqual(st.created, 1);
        assert.strictEqual(st.ok, false);
        assert.match(st.error, /Google 500/);
        const dec = creates[1].args;
        assert.strictEqual(dec.startDate, '2026-12-31');
        assert.strictEqual(dec.endDate, '2027-01-01');
        assert.strictEqual(dec.calendarId, 'primary');
        assert.strictEqual(dec.title, 'Facture');
        assert.deepStrictEqual(dec.privateProperties, {
            yuiRule: 'facture',
            yuiDate: '2026-12-31',
            yuiInstance: 'me',
        });
        assert.strictEqual(dec.startDateTime, undefined);
        assert.ok(st.at);
    }

    // 3. Minuté 23:30 + 60 min → fin le lendemain 00:30
    {
        const { calls, callTool } = fakeTool({});
        const s = new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [lateRule],
        });
        const st = await s.runOnce();
        assert.strictEqual(st.ok, true);
        assert.strictEqual(st.created, 2);
        const c = calls.find((x) => x.name === 'create_event')!.args;
        assert.strictEqual(c.startDateTime, '2026-11-30T23:30:00');
        assert.strictEqual(c.endDateTime, '2026-12-01T00:30:00');
        assert.strictEqual(c.startDate, undefined);
        assert.deepStrictEqual(c.privateProperties, {
            yuiRule: 'tard',
            yuiDate: '2026-11-30',
            yuiInstance: 'me',
        });
    }

    // 4. Ordre retraits → mises à jour → créations ; update minuté envoie la fin
    {
        const events = [
            {
                id: 'orph',
                calendarId: 'primary',
                title: 'X',
                date: '2026-12-02',
                allDay: true,
                start: null,
                durationMin: null,
                yuiRule: 'disparue',
                yuiDate: '2026-12-02',
                yuiInstance: 'me',
            },
            {
                id: 'old',
                calendarId: 'primary',
                title: 'Sauvegarde',
                date: '2026-11-30',
                allDay: false,
                start: '22:00',
                durationMin: 60,
                yuiRule: 'tard',
                yuiDate: '2026-11-30',
                yuiInstance: 'me',
            },
        ];
        const { calls, callTool } = fakeTool({ events });
        const s = new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [lateRule],
        });
        const st = await s.runOnce();
        assert.deepStrictEqual(
            calls.map((c) => c.name),
            [
                'list_tagged_events',
                'delete_event',
                'update_event',
                'create_event',
            ],
        );
        assert.deepStrictEqual(calls[1].args, {
            calendarId: 'primary',
            eventId: 'orph',
        });
        const u = calls[2].args;
        assert.strictEqual(u.eventId, 'old');
        assert.strictEqual(u.calendarId, 'primary');
        assert.strictEqual(u.startDateTime, '2026-11-30T23:30:00');
        assert.strictEqual(u.endDateTime, '2026-12-01T00:30:00');
        assert.deepStrictEqual(
            [st.removed, st.updated, st.created, st.ok],
            [1, 1, 1, true],
        );
    }

    // 5. Deux request() pendant un run lent → exactement un run de plus
    {
        const { calls, callTool } = fakeTool({ listDelayMs: 40 });
        const s = new CalendarRulesSync({ callTool, now, readRules: () => [] });
        s.request();
        await new Promise((r) => setTimeout(r, 5));
        s.request();
        s.request();
        await new Promise((r) => setTimeout(r, 200));
        assert.strictEqual(
            calls.filter((c) => c.name === 'list_tagged_events').length,
            2,
        );
        // Au repos, une demande relance un run
        s.request();
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(
            calls.filter((c) => c.name === 'list_tagged_events').length,
            3,
        );
    }

    // 6. runOnce concurrents : sérialisés (jamais deux listings simultanés)
    {
        let inFlight = 0;
        let maxInFlight = 0;
        const callTool = async (name: string) => {
            if (name === 'list_tagged_events') {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((r) => setTimeout(r, 20));
                inFlight--;
            }
            return { events: [], scanned: ['primary'] };
        };
        const s = new CalendarRulesSync({ callTool, now, readRules: () => [] });
        await Promise.all([s.runOnce(), s.runOnce()]);
        assert.strictEqual(maxInFlight, 1);
    }

    // 7. Agenda principal : alias 'primary' ↔ id réel (email) → aucun remplacement
    {
        const email = 'moi@gmail.com';
        const listed = (calendarId: string) => [
            {
                id: 'e1',
                calendarId,
                title: 'Facture',
                date: '2026-11-30',
                allDay: true,
                start: null,
                durationMin: null,
                yuiRule: 'facture',
                yuiDate: '2026-11-30',
                yuiInstance: 'me',
            },
            {
                id: 'e2',
                calendarId,
                title: 'Facture',
                date: '2026-12-31',
                allDay: true,
                start: null,
                durationMin: null,
                yuiRule: 'facture',
                yuiDate: '2026-12-31',
                yuiInstance: 'me',
            },
        ];
        const cases: Array<[string, string]> = [
            ['primary', 'primary'], // règle par défaut, listing en alias
            [email, 'primary'], // règle sur l'email, listing en alias
            ['primary', email], // listing en id réel (défensif)
        ];
        for (const [ruleCal, eventCal] of cases) {
            const calls: Call[] = [];
            const callTool = async (
                name: string,
                args: Record<string, unknown> = {},
            ) => {
                calls.push({ name, args });
                return {
                    events: listed(eventCal),
                    primaryId: email,
                    scanned: [email, 'pro@group.calendar.google.com'],
                };
            };
            const rule = { ...allDayRule, calendarId: ruleCal };
            const s = new CalendarRulesSync({
                callTool,
                now,
                readRules: () => [rule],
            });
            const st = await s.runOnce();
            assert.deepStrictEqual(
                calls.map((c) => c.name),
                ['list_tagged_events'],
                `${ruleCal}/${eventCal}`,
            );
            assert.strictEqual(st.ok, true);
        }
        // Un vrai changement d'agenda reste un remplacement
        const calls: Call[] = [];
        const callTool = async (
            name: string,
            args: Record<string, unknown> = {},
        ) => {
            calls.push({ name, args });
            return name === 'list_tagged_events'
                ? {
                      events: listed('primary'),
                      primaryId: email,
                      scanned: ['primary', 'pro@group.calendar.google.com'],
                  }
                : {};
        };
        const rule = {
            ...allDayRule,
            calendarId: 'pro@group.calendar.google.com',
        };
        await new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [rule],
        }).runOnce();
        assert.strictEqual(
            calls.filter((c) => c.name === 'delete_event').length,
            2,
        );
        const deleted = calls.find((c) => c.name === 'delete_event')!.args;
        assert.strictEqual(deleted.calendarId, 'primary');
        assert.strictEqual(
            calls.filter((c) => c.name === 'create_event').length,
            2,
        );
    }

    // 8. readRules qui lève → ok:false, aucune écriture, aucune promesse rejetée
    {
        const rejections: unknown[] = [];
        const onRej = (e: unknown) => rejections.push(e);
        process.on('unhandledRejection', onRej);
        const { calls, callTool } = fakeTool({});
        const s = new CalendarRulesSync({
            callTool,
            now,
            readRules: () => {
                throw new Error('disque KO');
            },
        });
        const st = await s.runOnce();
        assert.strictEqual(st.ok, false);
        assert.match(st.error, /disque KO/);
        s.request();
        await new Promise((r) => setTimeout(r, 30));
        assert.deepStrictEqual(
            [...new Set(calls.map((c) => c.name))],
            ['list_tagged_events'],
        );
        assert.strictEqual(s.status().ok, false);
        process.off('unhandledRejection', onRej);
        assert.strictEqual(rejections.length, 0);
    }

    // 9. Plan qui lève (règle corrompue en mémoire) → ok:false, pas de rejet
    {
        const { calls, callTool } = fakeTool({});
        const broken = Object.defineProperty({ ...allDayRule }, 'enabled', {
            get() {
                throw new Error('règle corrompue');
            },
        });
        const s = new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [broken],
        });
        const st = await s.runOnce();
        assert.strictEqual(st.ok, false);
        assert.ok(st.error);
        assert.deepStrictEqual(
            calls.map((c) => c.name),
            ['list_tagged_events'],
        );
    }

    const ev = (over: Record<string, unknown>) => ({
        id: 'x',
        calendarId: 'primary',
        title: 'Facture',
        date: '2026-11-30',
        allDay: true,
        start: null,
        durationMin: null,
        yuiRule: 'facture',
        yuiDate: '2026-11-30',
        yuiInstance: 'me',
        ...over,
    });

    // 10. Deux instances sur un compte : seuls NOS événements comptent
    {
        const events = [
            // règle inconnue ici, posée par une autre instance → jamais retirée
            ev({
                id: 'other-orph',
                yuiRule: 'chez-prod',
                yuiDate: '2026-12-02',
                date: '2026-12-02',
                yuiInstance: 'prod',
            }),
            // sans instance (ancien) → ignoré aussi
            ev({
                id: 'legacy-orph',
                yuiRule: 'vieille',
                yuiDate: '2026-12-03',
                date: '2026-12-03',
                yuiInstance: null,
            }),
            // même clé qu'une occurrence voulue, mais d'une autre instance
            ev({ id: 'other-same', yuiInstance: 'prod', title: 'Autre titre' }),
        ];
        const { calls, callTool } = fakeTool({ events });
        const st = await new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [allDayRule],
        }).runOnce();
        assert.strictEqual(
            calls.filter((c) => c.name === 'delete_event').length,
            0,
        );
        assert.strictEqual(
            calls.filter((c) => c.name === 'update_event').length,
            0,
        );
        const created = calls
            .filter((c) => c.name === 'create_event')
            .map((c) => (c.args.privateProperties as any).yuiDate);
        assert.deepStrictEqual(created, ['2026-11-30', '2026-12-31']);
        assert.strictEqual(st.ok, true);
    }

    // 11. Agenda d'une règle jamais parcouru → création sautée et signalée
    {
        const typo = {
            ...allDayRule,
            calendarId: 'typo@group.calendar.google.com',
        };
        const events = [
            ev({
                id: 'orph',
                yuiRule: 'disparue',
                yuiDate: '2026-12-02',
                date: '2026-12-02',
            }),
        ];
        const { calls, callTool } = fakeTool({ events, scanned: ['primary'] });
        const st = await new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [typo],
        }).runOnce();
        assert.strictEqual(
            calls.filter((c) => c.name === 'create_event').length,
            0,
        );
        assert.strictEqual(st.removed, 1, 'retraits non affectés');
        assert.strictEqual(st.ok, false);
        assert.match(
            st.error,
            /Agenda introuvable ou non modifiable : typo@group\.calendar\.google\.com/,
        );
        // Changement d'agenda vers un agenda non parcouru : la moitié « création » est sautée
        const moving = [
            ev({ id: 'a' }),
            ev({ id: 'b', date: '2026-12-31', yuiDate: '2026-12-31' }),
        ];
        const f2 = fakeTool({ events: moving, scanned: ['primary'] });
        const st2 = await new CalendarRulesSync({
            callTool: f2.callTool,
            now,
            readRules: () => [typo],
        }).runOnce();
        assert.strictEqual(
            f2.calls.filter((c) => c.name === 'delete_event').length,
            2,
        );
        assert.strictEqual(
            f2.calls.filter((c) => c.name === 'create_event').length,
            0,
        );
        assert.match(st2.error, /Agenda introuvable/);
        // Réponse sans `scanned` (ancien mcp-calendar) → abandon, rien d'écrit
        const calls3: Call[] = [];
        const st3 = await new CalendarRulesSync({
            callTool: async (
                name: string,
                args: Record<string, unknown> = {},
            ) => {
                calls3.push({ name, args });
                return { events: [] };
            },
            now,
            readRules: () => [allDayRule],
        }).runOnce();
        assert.strictEqual(st3.ok, false);
        assert.strictEqual(calls3.length, 1);
    }

    // 12. Règle invalide dans le fichier : ses événements sont gelés
    {
        const events = [
            ev({
                id: 'frozen',
                yuiRule: 'cassee',
                yuiDate: '2026-12-02',
                date: '2026-12-02',
            }),
            ev({
                id: 'orph',
                yuiRule: 'disparue',
                yuiDate: '2026-12-03',
                date: '2026-12-03',
            }),
        ];
        const { calls, callTool } = fakeTool({ events });
        const st = await new CalendarRulesSync({
            callTool,
            now,
            readRules: () => ({ rules: [], invalid: ['cassee'] }),
        }).runOnce();
        const deleted = calls
            .filter((c) => c.name === 'delete_event')
            .map((c) => c.args.eventId);
        assert.deepStrictEqual(deleted, ['orph']);
        assert.strictEqual(
            calls.filter((c) => c.name === 'update_event').length,
            0,
        );
        assert.strictEqual(st.ok, true);
    }

    // 13. Fichier de règles illisible (store réel) → ok:false, rien d'écrit
    {
        const rulesFile = path.join(tmp, 'config', 'calendar-rules.json');
        fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
        fs.writeFileSync(rulesFile, '{cassé');
        const events = [
            ev({
                id: 'orph',
                yuiRule: 'disparue',
                yuiDate: '2026-12-03',
                date: '2026-12-03',
            }),
        ];
        const { calls, callTool } = fakeTool({ events });
        const st = await new CalendarRulesSync({ callTool, now }).runOnce();
        assert.strictEqual(st.ok, false);
        assert.match(st.error, /illisible/);
        assert.deepStrictEqual(
            calls.map((c) => c.name),
            ['list_tagged_events'],
        );
        // Entrée invalide via le store réel → gelée
        fs.writeFileSync(
            rulesFile,
            JSON.stringify({
                rules: [{ id: 'disparue', title: 'X', kind: 'inconnu' }],
            }),
        );
        const f2 = fakeTool({ events });
        const st2 = await new CalendarRulesSync({
            callTool: f2.callTool,
            now,
        }).runOnce();
        assert.strictEqual(st2.ok, true);
        assert.deepStrictEqual(
            f2.calls.map((c) => c.name),
            ['list_tagged_events'],
        );
        fs.rmSync(rulesFile);
    }

    // 14. delete_event 404/410 (déjà supprimé) = succès
    for (const msg of [
        'Error: Request failed with status code 404',
        'GaxiosError: Resource has been deleted (410)',
        'Not Found',
    ]) {
        const events = [
            ev({
                id: 'orph',
                yuiRule: 'disparue',
                yuiDate: '2026-12-03',
                date: '2026-12-03',
            }),
        ];
        const { callTool } = fakeTool({ events, deleteError: msg });
        const st = await new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [],
        }).runOnce();
        assert.strictEqual(st.ok, true, msg);
        assert.strictEqual(st.removed, 1, msg);
    }
    {
        const events = [
            ev({
                id: 'orph',
                yuiRule: 'disparue',
                yuiDate: '2026-12-03',
                date: '2026-12-03',
            }),
        ];
        const { callTool } = fakeTool({ events, deleteError: 'Google 500' });
        const st = await new CalendarRulesSync({
            callTool,
            now,
            readRules: () => [],
        }).runOnce();
        assert.strictEqual(st.ok, false);
        assert.strictEqual(st.removed, 0);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('calendarRules/sync.test OK');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
