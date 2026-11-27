import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-reminders-'));
process.env.YUI_DATA_DIR = tmp;

const { ReminderRunner } = require('./runner') as typeof import('./runner');
const scheduleStore =
    require('../../schedule/store') as typeof import('../../schedule/store');
const { DEFAULT_REMINDER_SETTINGS } =
    require('./types') as typeof import('./types');
import type { ParcelInfo } from './types';
import type { JournalEntry } from '../journal';
import type { Event } from '../events';
import type { Situation } from '../situation';

const at = (d: number, h: number, m = 0, s = 0) =>
    new Date(2026, 10, d, h, m, s);
const REG = path.join(tmp, 'state', 'reminders-shadow.json');

interface Opts {
    agendaDown?: boolean;
    /** Réponse brute de get_schedule (ex. texte d'erreur MCP). */
    agendaRaw?: unknown;
    events?: Array<Record<string, unknown>>;
    rain?: boolean;
}

function setup(opts: Opts = {}) {
    const calls: string[] = [];
    const recorded: Array<Omit<JournalEntry, 'id'>> = [];
    let clock = at(27, 12);
    let presence: 'home' | 'away' | 'unknown' = 'home';
    let parcels: ParcelInfo[] = [];
    let held: Event[] = [];
    let situation: Situation | null = null;
    let presenceCb: ((prev: string, next: string) => void) | null = null;
    // Une fermeture par setup : le cache d'agenda est indexé par elle.
    const callTool = async (name: string) => {
        calls.push(name);
        if (name === 'get_schedule') {
            if (opts.agendaDown) throw new Error('agenda KO');
            if ('agendaRaw' in opts) return opts.agendaRaw;
            const byDate = new Map<string, unknown[]>();
            for (const e of opts.events ?? []) {
                const d = String(e.date);
                byDate.set(d, [...(byDate.get(d) ?? []), e]);
            }
            return {
                days: [...byDate].map(([date, events]) => ({ date, events })),
            };
        }
        if (name === 'get_today_forecast') {
            return JSON.stringify({
                periods: [
                    {
                        period: 'night',
                        precipitation_prob: 90,
                        precipitation_mm: 5,
                    },
                    {
                        period: 'morning',
                        precipitation_prob: opts.rain ? 80 : 10,
                        precipitation_mm: 0,
                    },
                    {
                        period: 'afternoon',
                        precipitation_prob: 0,
                        precipitation_mm: 0,
                    },
                    {
                        period: 'evening',
                        precipitation_prob: 0,
                        precipitation_mm: 0,
                    },
                ],
            });
        }
        return null;
    };
    const mk = () =>
        new ReminderRunner({
            callTool,
            journal: { record: (e) => void recorded.push(e) },
            presenceState: () => presence,
            subscribePresence: (cb) => {
                presenceCb = cb;
                return () => {
                    presenceCb = null;
                };
            },
            getSituation: () => situation,
            heldList: () => held,
            todayWake: () => null,
            listParcels: () => parcels,
            settings: () => DEFAULT_REMINDER_SETTINGS,
            quietHours: () => ({ start: '23:00', end: '07:00' }),
            now: () => clock,
        });
    return {
        calls,
        recorded,
        mk,
        setNow: (d: Date) => (clock = d),
        setPresence: (p: typeof presence) => (presence = p),
        setParcels: (p: ParcelInfo[]) => (parcels = p),
        setHeld: (h: Event[]) => (held = h),
        setSituation: (s: Situation | null) => (situation = s),
        setAgendaRaw: (raw: unknown) => (opts.agendaRaw = raw),
        setAgendaOk: () => delete opts.agendaRaw,
        firePresence: (prev: string, next: string) => presenceCb?.(prev, next),
        hasPresenceCb: () => presenceCb !== null,
    };
}

function reset() {
    fs.rmSync(path.join(tmp, 'state'), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, 'config'), { recursive: true, force: true });
}

const kine = {
    id: 'kine',
    title: 'Kiné',
    date: '2026-11-28',
    start: '09:00',
    duration_min: 45,
    location: '12 rue X',
    calendar: 'Perso',
};

async function run() {
    // ── Veille : une seule fois, même après redémarrage ─────────────────
    reset();
    let s = setup({ events: [kine] });
    let r = s.mk();
    s.setNow(at(27, 21, 0, 30));
    let out = await r.tick();
    assert.strictEqual(out.length, 1);
    assert.strictEqual(s.recorded.length, 1);
    const e = s.recorded[0];
    assert.strictEqual(e.source, 'reminders');
    assert.strictEqual(e.subject, 'agenda:veille:2026-11-28');
    assert.strictEqual(e.channel, 'skip');
    assert.strictEqual(e.shadow, true);
    assert.ok(!('event' in e), 'pas de champ event');
    assert.strictEqual(e.at, at(27, 21, 0, 30).getTime());
    assert.ok(e.message.startsWith('Demain : 9h Kiné'), e.message);
    assert.ok(e.facts && e.facts[0].startsWith('Demain : neuf heures'));
    assert.strictEqual(e.reason, 'aurait notifié');
    const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
    assert.strictEqual(
        reg['agenda:veille:2026-11-28'],
        at(27, 21, 0, 30).getTime(),
    );
    s.setNow(at(27, 21, 0, 50));
    assert.strictEqual((await r.tick()).length, 0);
    const r2 = s.mk();
    s.setNow(at(27, 21, 1));
    assert.strictEqual((await r2.tick()).length, 0);
    assert.strictEqual(s.recorded.length, 1, 'jamais deux fois la veille');

    // ── Hors fenêtre : rien, pas de météo ───────────────────────────────
    reset();
    s = setup({ events: [kine] });
    r = s.mk();
    for (const t of [at(27, 15), at(27, 21, 31), at(27, 20, 59)]) {
        s.setNow(t);
        assert.strictEqual((await r.tick()).length, 0, String(t));
    }
    assert.strictEqual(s.recorded.length, 0);
    assert.ok(!s.calls.includes('get_today_forecast'));

    // ── Colis : premier passage = amorçage silencieux ──────────────────
    reset();
    s = setup();
    r = s.mk();
    s.setNow(at(27, 12));
    s.setParcels([
        {
            id: 'p1',
            label: 'clavier',
            status: 'delivered',
            updatedAt: at(27, 11).getTime(),
        },
    ]);
    assert.strictEqual((await r.tick()).length, 0);
    assert.strictEqual(s.recorded.length, 0);
    assert.ok(
        JSON.parse(fs.readFileSync(REG, 'utf8'))['parcel:p1:delivered'],
        'clé amorcée',
    );
    s.setParcels([
        {
            id: 'p1',
            label: 'clavier',
            status: 'delivered',
            updatedAt: at(27, 11).getTime(),
        },
        {
            id: 'p2',
            label: 'souris',
            status: 'out_for_delivery',
            updatedAt: at(27, 12).getTime(),
        },
    ]);
    s.setNow(at(27, 12, 1));
    out = await r.tick();
    assert.deepStrictEqual(
        out.map((x) => x.key),
        ['parcel:p2:out_for_delivery'],
    );
    assert.strictEqual(s.recorded.length, 1);
    assert.strictEqual(
        s.recorded[0].message,
        "Colis « souris » en livraison aujourd'hui",
    );

    // ── Agenda en panne : pas d'exception, le colis part quand même ────
    // (registre déjà présent : pas un premier passage)
    s = setup({ agendaDown: true });
    r = s.mk();
    s.setNow(at(27, 13));
    s.setParcels([
        {
            id: 'p3',
            label: 'écran',
            status: 'pickup_ready',
            updatedAt: at(27, 12, 30).getTime(),
        },
    ]);
    out = await r.tick();
    assert.deepStrictEqual(
        out.map((x) => x.key),
        ['parcel:p3:pickup_ready'],
    );
    assert.strictEqual(s.recorded.length, 1);

    // ── Deux rappels à la fois : un seul enregistrement fusionné ───────
    s = setup();
    r = s.mk();
    s.setNow(at(27, 14));
    s.setPresence('home');
    s.setParcels([
        {
            id: 'a',
            label: 'A',
            status: 'delivered',
            updatedAt: at(27, 13, 50).getTime(),
        },
        {
            id: 'b',
            label: 'B',
            status: 'problem',
            updatedAt: at(27, 13, 55).getTime(),
        },
    ]);
    out = await r.tick();
    assert.strictEqual(out.length, 2);
    assert.strictEqual(s.recorded.length, 1);
    const m = s.recorded[0];
    assert.strictEqual(m.subject, 'parcel:a:delivered,parcel:b:problem');
    assert.strictEqual(
        m.message,
        'Colis « A » livré\nColis « B » : problème de livraison',
    );
    assert.strictEqual(m.facts?.length, 1);
    assert.strictEqual(m.reason, 'aurait parlé', 'livré + présent');
    assert.strictEqual(m.shadow, true);
    assert.strictEqual(m.channel, 'skip');

    // absent : aurait notifié
    s = setup();
    r = s.mk();
    s.setNow(at(27, 14, 30));
    s.setPresence('away');
    s.setParcels([
        {
            id: 'c',
            label: 'C',
            status: 'delivered',
            updatedAt: at(27, 14, 20).getTime(),
        },
    ]);
    await r.tick();
    assert.strictEqual(s.recorded[0].reason, 'aurait notifié');

    // ── Départ : météo lue seulement dans la fenêtre ───────────────────
    reset();
    scheduleStore.setWeek(
        Object.fromEntries(
            ['0', '1', '2', '3', '4', '5', '6'].map((k) => [
                k,
                { mode: 'onsite', leave: '09:00', back: '18:00' },
            ]),
        ),
    );
    s = setup({ rain: true });
    r = s.mk();
    s.setNow(at(27, 8, 30));
    await r.tick();
    assert.ok(!s.calls.includes('get_today_forecast'), 'avant la fenêtre');
    s.setNow(at(27, 8, 45));
    out = await r.tick();
    assert.ok(s.calls.includes('get_today_forecast'));
    assert.deepStrictEqual(
        out.map((x) => x.key),
        ['depart:2026-11-27'],
    );
    assert.ok(s.recorded[0].message.endsWith('· pluie'), s.recorded[0].message);

    // pas de pluie à venir (la nuit pluvieuse est passée)
    reset();
    scheduleStore.setWeek(
        Object.fromEntries(
            ['0', '1', '2', '3', '4', '5', '6'].map((k) => [
                k,
                { mode: 'onsite', leave: '09:00', back: '18:00' },
            ]),
        ),
    );
    s = setup({ rain: false });
    r = s.mk();
    s.setNow(at(27, 8, 45));
    await r.tick();
    assert.strictEqual(s.recorded[0].message, 'Départ dans 15 min');

    // ── Retour : la présence alimente lastDepartureAt / returnedAt ─────
    s = setup();
    r = s.mk();
    r.start();
    assert.ok(s.hasPresenceCb(), 'abonné à la présence');
    s.setNow(at(27, 10));
    s.firePresence('home', 'away');
    s.setParcels([
        {
            id: 'r1',
            label: 'livre',
            status: 'delivered',
            updatedAt: at(27, 15).getTime(),
        },
    ]);
    s.setNow(at(27, 18, 0));
    s.firePresence('away', 'home');
    s.setNow(at(27, 18, 2));
    out = await r.tick();
    assert.ok(
        out.some((x) => x.key === 'retour:2026-11-27'),
        JSON.stringify(out.map((x) => x.key)),
    );
    r.stop();
    assert.ok(!s.hasPresenceCb(), 'désabonné');

    // ── Contexte : mails, post-its, notes ──────────────────────────────
    reset();
    fs.mkdirSync(path.dirname(REG), { recursive: true });
    fs.writeFileSync(REG, '{}');
    s = setup();
    r = s.mk();
    const heldEv = (
        p: Partial<Event> & { key: string; subject: string },
    ): Event =>
        ({
            source: 'mail',
            kind: 'info',
            importance: 'info',
            facts: [],
            at: at(27, 8).getTime(),
            ...p,
        } as Event);
    s.setHeld([
        heldEv({
            key: 'mail-notify-1',
            subject: 'Mail — URSSAF : « Échéance »',
        }),
        heldEv({ key: 'mail-notify-2', subject: 'Mail — Malt : « Facture »' }),
        heldEv({
            key: 'mail-notify-3',
            subject: 'Mail — URSSAF : « Relance »',
        }),
        heldEv({
            key: 'mail-info-4',
            subject: 'Courrier — Qonto : « Relevé »',
        }),
        heldEv({
            key: 'mail-info-5',
            subject: 'Courrier — Free : « Facture »',
        }),
        heldEv({
            source: 'koya',
            key: 'k1',
            subject: 'Note info',
            importance: 'info',
        }),
        heldEv({
            source: 'koya',
            key: 'k2',
            subject: 'Note urgente',
            importance: 'urgent',
        }),
        heldEv({
            source: 'koya',
            key: 'k3',
            subject: 'Note utile',
            importance: 'utile',
        }),
    ]);
    s.setSituation({
        sections: {
            yoji: [
                { label: 'Post-it ancien', value: 'rappeler le kiné (12 j)' },
                { label: 'Autre', value: 'x' },
            ],
        },
    } as unknown as Situation);
    s.setNow(at(27, 9, 5));
    out = await r.tick();
    const morning = out.find((x) => x.type === 'morning');
    assert.ok(morning, 'point du matin à 09:00 (repli)');
    assert.ok(
        morning.notif.includes('5 mails à traiter : URSSAF, Malt, Qonto ·'),
        morning.notif,
    );
    assert.ok(
        morning.notif.includes('post-it : rappeler le kiné ·'),
        morning.notif,
    );
    assert.ok(!morning.notif.includes('(12 j)'), morning.notif);
    assert.ok(morning.notif.includes('Note urgente'), morning.notif);
    assert.ok(!morning.notif.includes('Note info'), morning.notif);

    // ── Agenda en erreur (texte MCP isError) : pas de point du matin, la
    //    clé reste libre et le point part au tick suivant qui lit l'agenda ──
    reset();
    fs.mkdirSync(path.dirname(REG), { recursive: true });
    fs.writeFileSync(REG, '{}');
    s = setup({ agendaRaw: 'Error: token expired' });
    r = s.mk();
    s.setNow(at(27, 9, 2));
    out = await r.tick();
    assert.ok(
        !out.some((x) => x.type === 'morning'),
        JSON.stringify(out.map((x) => x.key)),
    );
    assert.strictEqual(s.recorded.length, 0);
    assert.ok(
        !('matin:2026-11-27' in JSON.parse(fs.readFileSync(REG, 'utf8'))),
        'clé du matin non marquée',
    );
    s.setAgendaOk();
    s.setNow(at(27, 9, 10)); // > TTL du cache d'agenda
    out = await r.tick();
    assert.deepStrictEqual(
        out.map((x) => x.key),
        ['matin:2026-11-27'],
    );
    assert.strictEqual(s.recorded.length, 1);
    assert.ok(
        JSON.parse(fs.readFileSync(REG, 'utf8'))['matin:2026-11-27'],
        'marquée une fois dit',
    );

    // fenêtre vide de mcp-calendar `{events: []}` : une journée vide, pas
    // une panne
    reset();
    fs.mkdirSync(path.dirname(REG), { recursive: true });
    fs.writeFileSync(REG, '{}');
    s = setup({ agendaRaw: { events: [], start: 'a', end: 'b' } });
    r = s.mk();
    s.setNow(at(27, 9, 2));
    out = await r.tick();
    assert.deepStrictEqual(
        out.map((x) => x.key),
        ['matin:2026-11-27'],
    );
    assert.ok(s.recorded[0].message.startsWith("Rien à l'agenda ajd"));

    console.log('All reminder runner tests passed');
}

run().catch((e) => {
    console.error(e.stack ?? e);
    process.exit(1);
});
