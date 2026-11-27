import assert from 'assert';
import type { AgendaEvent } from '../../agendaSecretary';
import type { DayPlan } from '../../schedule/dayPlan';
import {
    departDue,
    dueReminders,
    eveDue,
    imminentDue,
    morningDue,
    parcelDue,
    returnDue,
} from './policies';
import {
    DEFAULT_REMINDER_SETTINGS,
    type ParcelInfo,
    type ReminderContext,
} from './types';

const TODAY = '2026-11-27';
const TOMORROW = '2026-11-28';
const at = (h: number, m = 0, s = 0) => new Date(2026, 10, 27, h, m, s);

const plan = (p: Partial<DayPlan> = {}): DayPlan => ({
    date: TODAY,
    mode: 'remote',
    reason: 'defaut',
    ...p,
});

function ev(p: Partial<AgendaEvent> & { title: string }): AgendaEvent {
    return {
        id: p.title,
        date: TODAY,
        endDate: null,
        start: '10:00',
        allDay: false,
        location: null,
        description: null,
        durationMin: 60,
        attendees: [],
        calendar: 'Perso',
        ...p,
    };
}
const visio = (p: Partial<AgendaEvent> & { title: string }) =>
    ev({ meetLink: 'https://meet.google.com/x', ...p });
const onsite = (p: Partial<AgendaEvent> & { title: string }) =>
    ev({ location: '12 rue de la Paix, Paris', ...p });

function ctx(p: Partial<ReminderContext> = {}): ReminderContext {
    return {
        now: at(12),
        today: TODAY,
        tomorrow: TOMORROW,
        presence: 'home',
        quietHours: { start: '23:00', end: '07:00' },
        plans: { today: plan(), tomorrow: plan({ date: TOMORROW }) },
        events: [],
        calendarOk: true,
        wake: null,
        parcels: [],
        mails: [],
        mailCount: 0,
        postits: [],
        notes: [],
        weather: null,
        lastDepartureAt: null,
        returnedAt: null,
        settings: { ...DEFAULT_REMINDER_SETTINGS },
        ...p,
    };
}
const none = () => false;
const parcel = (p: Partial<ParcelInfo> = {}): ParcelInfo => ({
    id: 'p1',
    label: 'clavier',
    status: 'in_transit',
    updatedAt: at(11).getTime(),
    ...p,
});

// --- morning ---
{
    const wake = { at: at(6, 30).getTime(), afterMin: 5, device: 'Chambre' };
    assert.strictEqual(
        morningDue(ctx({ now: at(6, 34, 59), wake }), none).length,
        0,
    );
    const r = morningDue(ctx({ now: at(6, 35), wake }), none);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].key, `matin:${TODAY}`);
    assert.strictEqual(r[0].device, 'Chambre');
    assert.strictEqual(r[0].wantsSpeech, true);
    // despite quiet hours, via dueReminders
    assert.strictEqual(
        dueReminders(ctx({ now: at(6, 36), wake }), none).length,
        1,
    );
    // window closes after 30 min (restart flood protection)
    assert.strictEqual(
        morningDue(ctx({ now: at(7, 5), wake }), none).length,
        0,
    );
    assert.strictEqual(
        morningDue(ctx({ now: at(7, 4, 59), wake }), none).length,
        1,
    );
    // done key skipped
    assert.strictEqual(
        morningDue(ctx({ now: at(6, 35), wake }), (k) => k === `matin:${TODAY}`)
            .length,
        0,
    );
    // no device when wake.device null
    const w2 = { ...wake, device: null };
    assert.strictEqual(
        morningDue(ctx({ now: at(6, 35), wake: w2 }), none)[0].device,
        undefined,
    );
}
{
    // fallback 09:00
    assert.strictEqual(morningDue(ctx({ now: at(8, 59) }), none).length, 0);
    assert.strictEqual(morningDue(ctx({ now: at(9, 0) }), none).length, 1);
    assert.strictEqual(morningDue(ctx({ now: at(9, 30) }), none).length, 0);
    // off day: never
    const off = ctx({
        now: at(9, 5),
        plans: { today: plan({ mode: 'off' }), tomorrow: null },
    });
    assert.strictEqual(morningDue(off, none).length, 0);
    // unknown plan: not off
    assert.strictEqual(
        morningDue(
            ctx({ now: at(9, 5), plans: { today: null, tomorrow: null } }),
            none,
        ).length,
        1,
    );
    // off day but wake-up exists: fires
    const wake = { at: at(9, 0).getTime(), afterMin: 5, device: null };
    assert.strictEqual(morningDue({ ...off, wake }, none).length, 1);
    // repli 09:00 : jamais pendant la nuit (silence jusqu'à 09:30)
    assert.strictEqual(
        morningDue(
            ctx({
                now: at(9, 5),
                quietHours: { start: '23:00', end: '09:30' },
            }),
            none,
        ).length,
        0,
    );
    // content includes events
    const c = ctx({ now: at(9, 5), events: [visio({ title: 'Standup' })] });
    assert.ok(morningDue(c, none)[0].notif.includes('Standup'));
}

// --- agenda en panne : ni matin, ni veille, ni imminent ---
{
    const wake = { at: at(6, 30).getTime(), afterMin: 5, device: null };
    assert.strictEqual(
        morningDue(ctx({ now: at(6, 35), wake, calendarOk: false }), none)
            .length,
        0,
    );
    assert.strictEqual(
        morningDue(ctx({ now: at(9, 5), calendarOk: false }), none).length,
        0,
    );
    const tomorrowEv = [
        ev({ title: 'Dentiste', date: TOMORROW, start: '09:00' }),
    ];
    assert.strictEqual(
        eveDue(
            ctx({ now: at(21, 5), events: tomorrowEv, calendarOk: false }),
            none,
        ).length,
        0,
    );
    const v = visio({ title: 'Call', start: '10:00' });
    assert.strictEqual(
        imminentDue(
            ctx({ now: at(9, 55), events: [v], calendarOk: false }),
            none,
        ).length,
        0,
    );
}

// --- eve ---
{
    const tEv = (p: Partial<AgendaEvent> & { title: string }) =>
        ev({ date: TOMORROW, ...p });
    const events = [tEv({ title: 'Dentiste', start: '09:00' })];
    assert.strictEqual(
        eveDue(ctx({ now: at(20, 59), events }), none).length,
        0,
    );
    const r = eveDue(ctx({ now: at(21, 0, 30), events }), none);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].key, `agenda:veille:${TOMORROW}`);
    assert.strictEqual(r[0].wantsSpeech, false);
    assert.ok(r[0].notif.includes('Dentiste'));
    // restart at 21:01 -> same key, done skips it
    assert.strictEqual(
        eveDue(ctx({ now: at(21, 1), events }), (k) => k === r[0].key).length,
        0,
    );
    // window 30 min
    assert.strictEqual(
        eveDue(ctx({ now: at(21, 30), events }), none).length,
        0,
    );
    assert.strictEqual(
        eveDue(ctx({ now: at(21, 29), events }), none).length,
        1,
    );
    // nothing tomorrow
    assert.strictEqual(eveDue(ctx({ now: at(21, 5) }), none).length, 0);
    // family event counts
    const fam = [
        tEv({ title: 'Anniv', allDay: true, start: null, calendar: 'Famille' }),
    ];
    assert.strictEqual(
        eveDue(ctx({ now: at(21, 5), events: fam }), none).length,
        1,
    );
    // parcels: expected tomorrow, not delivered
    const parcels = [
        parcel({ id: 'a', label: 'clavier', estimatedDate: TOMORROW }),
        parcel({
            id: 'b',
            label: 'livre',
            estimatedDate: TOMORROW,
            status: 'delivered',
        }),
    ];
    const rp = eveDue(
        ctx({ now: at(21, 5), events, parcels, mails: ['Anna'], mailCount: 1 }),
        none,
    )[0];
    assert.ok(rp.notif.includes('clavier'));
    assert.ok(!rp.notif.includes('livre'));
    assert.ok(rp.notif.includes('Anna'));
    // colis attendu demain sans aucun événement : la veille part quand même
    const onlyParcel = eveDue(
        ctx({ now: at(21, 5), parcels: [parcel({ estimatedDate: TOMORROW })] }),
        none,
    );
    assert.strictEqual(onlyParcel.length, 1);
    assert.strictEqual(
        onlyParcel[0].notif,
        'Demain : Colis « clavier » attendu',
    );
    // colis déjà livré ou attendu un autre jour : rien
    assert.strictEqual(
        eveDue(
            ctx({
                now: at(21, 5),
                parcels: [
                    parcel({ estimatedDate: TOMORROW, status: 'delivered' }),
                    parcel({ id: 'z', estimatedDate: TODAY }),
                ],
            }),
            none,
        ).length,
        0,
    );
    // night (quiet hours) suppresses, e.g. quiet starting at 21:00
    const q = ctx({
        now: at(21, 5),
        events,
        quietHours: { start: '20:00', end: '07:00' },
    });
    assert.strictEqual(dueReminders(q, none).length, 0);
}

// --- imminent ---
{
    const v = visio({ title: 'Call', start: '10:00' });
    assert.strictEqual(
        imminentDue(ctx({ now: at(9, 49), events: [v] }), none).length,
        0,
    );
    const r = imminentDue(ctx({ now: at(9, 50), events: [v] }), none);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].key, 'agenda:Call:pre');
    assert.strictEqual(r[0].wantsSpeech, true);
    // after the start: never (restart protection)
    assert.strictEqual(
        imminentDue(ctx({ now: at(10, 0), events: [v] }), none).length,
        0,
    );
    assert.strictEqual(
        imminentDue(ctx({ now: at(9, 59), events: [v] }), none).length,
        1,
    );
    // done
    assert.strictEqual(
        imminentDue(
            ctx({ now: at(9, 55), events: [v] }),
            (k) => k === 'agenda:Call:pre',
        ).length,
        0,
    );
    // unknown mode = visio lead (10 min)
    const u = ev({ title: 'Truc', start: '10:00' });
    assert.strictEqual(
        imminentDue(ctx({ now: at(9, 45), events: [u] }), none).length,
        0,
    );
    assert.strictEqual(
        imminentDue(ctx({ now: at(9, 50), events: [u] }), none).length,
        1,
    );
    // onsite: 45 min, only if home
    const o = onsite({ title: 'RDV', start: '10:00' });
    assert.strictEqual(
        imminentDue(ctx({ now: at(9, 14), events: [o] }), none).length,
        0,
    );
    assert.strictEqual(
        imminentDue(ctx({ now: at(9, 15), events: [o] }), none).length,
        1,
    );
    assert.strictEqual(
        imminentDue(
            ctx({ now: at(9, 15), events: [o], presence: 'away' }),
            none,
        ).length,
        0,
    );
    // visio does not require home
    assert.strictEqual(
        imminentDue(
            ctx({ now: at(9, 55), events: [v], presence: 'away' }),
            none,
        ).length,
        1,
    );
    // all-day, family, holiday, week numbers: never
    const bad = [
        ev({ title: 'AllDay', allDay: true, start: null }),
        visio({ title: 'Fam', start: '10:00', calendar: 'Famille' }),
        visio({
            title: 'Noel',
            start: '10:00',
            calendar: 'Jours fériés en France',
        }),
        visio({ title: 'S48', start: '10:00', calendar: 'Numéros de semaine' }),
    ];
    assert.strictEqual(
        imminentDue(ctx({ now: at(9, 55), events: bad }), none).length,
        0,
    );
    // events of other days ignored
    const other = visio({ title: 'Demain', date: TOMORROW, start: '10:00' });
    assert.strictEqual(
        imminentDue(ctx({ now: at(9, 55), events: [other] }), none).length,
        0,
    );
    // off day: personal still reminded
    const off = ctx({
        now: at(9, 55),
        events: [v],
        plans: { today: plan({ mode: 'off' }), tomorrow: null },
    });
    assert.strictEqual(imminentDue(off, none).length, 1);
    // night suppresses
    const n = ctx({
        now: at(6, 55),
        events: [visio({ title: 'Tot', start: '07:00' })],
    });
    assert.strictEqual(dueReminders(n, none).length, 0);
}

// --- depart ---
{
    const onP = plan({ mode: 'onsite', leave: '08:30', back: '18:30' });
    const plans = { today: onP, tomorrow: null };
    const base = { plans };
    assert.strictEqual(
        departDue(ctx({ ...base, now: at(8, 14) }), none).length,
        0,
    );
    const r = departDue(ctx({ ...base, now: at(8, 15) }), none);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].key, `depart:${TODAY}`);
    assert.strictEqual(r[0].wantsSpeech, true);
    assert.ok(r[0].notif.includes('15'));
    // window 30 min
    assert.strictEqual(
        departDue(ctx({ ...base, now: at(8, 45) }), none).length,
        0,
    );
    assert.strictEqual(
        departDue(ctx({ ...base, now: at(8, 44) }), none).length,
        1,
    );
    // away / remote
    assert.strictEqual(
        departDue(ctx({ ...base, now: at(8, 20), presence: 'away' }), none)
            .length,
        0,
    );
    assert.strictEqual(
        departDue(
            ctx({ now: at(8, 20), plans: { today: plan(), tomorrow: null } }),
            none,
        ).length,
        0,
    );
    // leave default 08:30 when absent
    const noLeave = { today: plan({ mode: 'onsite' }), tomorrow: null };
    assert.strictEqual(
        departDue(ctx({ plans: noLeave, now: at(8, 20) }), none).length,
        1,
    );
    // first RDV: onsite one preferred over earlier visio
    const events = [
        visio({ title: 'Visio9', start: '09:00' }),
        onsite({ title: 'Site10', start: '10:00' }),
        visio({ title: 'Avant', start: '07:00' }),
    ];
    const rv = departDue(ctx({ ...base, events, now: at(8, 20) }), none)[0];
    assert.ok(rv.notif.includes('Site10'));
    assert.ok(!rv.notif.includes('Avant'));
    // else first timed event >= leave
    const rv2 = departDue(
        ctx({ ...base, events: [events[0]], now: at(8, 20) }),
        none,
    )[0];
    assert.ok(rv2.notif.includes('Visio9'));
    // family/all-day not RDV
    const rv3 = departDue(
        ctx({
            ...base,
            events: [
                visio({ title: 'Fam', start: '09:00', calendar: 'Famille' }),
            ],
            now: at(8, 20),
        }),
        none,
    )[0];
    assert.ok(!rv3.notif.includes('Fam'));
    // weather
    const rw = departDue(
        ctx({ ...base, weather: { notable: 'pluie' }, now: at(8, 20) }),
        none,
    )[0];
    assert.ok(rw.notif.includes('pluie'));
    // night: leave at 06:30 with quiet until 07:00 is suppressed
    const early = {
        today: plan({ mode: 'onsite', leave: '06:30' }),
        tomorrow: null,
    };
    assert.strictEqual(
        dueReminders(ctx({ plans: early, now: at(6, 20) }), none).length,
        0,
    );
}

// --- parcel ---
{
    const mk = (status: string, p: Partial<ParcelInfo> = {}) =>
        ctx({ parcels: [parcel({ status, ...p })] });
    const d = parcelDue(mk('delivered'), none);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].key, 'parcel:p1:delivered');
    assert.strictEqual(d[0].wantsSpeech, true);
    for (const s of ['out_for_delivery', 'pickup_ready', 'problem']) {
        const r = parcelDue(mk(s), none);
        assert.strictEqual(r.length, 1, s);
        assert.strictEqual(r[0].wantsSpeech, false, s);
        assert.strictEqual(r[0].key, `parcel:p1:${s}`);
    }
    assert.strictEqual(parcelDue(mk('in_transit'), none).length, 0);
    // stale (> 6 h)
    assert.strictEqual(
        parcelDue(mk('delivered', { updatedAt: at(5, 59).getTime() }), none)
            .length,
        0,
    );
    assert.strictEqual(
        parcelDue(mk('delivered', { updatedAt: at(6, 1).getTime() }), none)
            .length,
        1,
    );
    // done
    assert.strictEqual(
        parcelDue(mk('delivered'), (k) => k === 'parcel:p1:delivered').length,
        0,
    );
    // night
    assert.strictEqual(
        dueReminders(
            ctx({
                now: at(23, 30),
                parcels: [
                    parcel({
                        status: 'delivered',
                        updatedAt: at(23, 0).getTime(),
                    }),
                ],
            }),
            none,
        ).length,
        0,
    );
}

// --- return ---
{
    const onP = { today: plan({ mode: 'onsite' }), tomorrow: null };
    const dep = at(8, 30).getTime();
    const ret = at(18, 40).getTime();
    const mk = (p: Partial<ReminderContext> = {}) =>
        ctx({
            now: at(18, 45),
            plans: onP,
            lastDepartureAt: dep,
            returnedAt: ret,
            parcels: [
                parcel({ status: 'delivered', updatedAt: at(14).getTime() }),
            ],
            ...p,
        });
    const r = returnDue(mk(), none);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].key, `retour:${TODAY}`);
    assert.strictEqual(r[0].wantsSpeech, true);
    assert.ok(r[0].notif.includes('pendant ton absence'));
    assert.ok(r[0].notif.includes('clavier'));
    // too late (> 10 min)
    assert.strictEqual(returnDue(mk({ now: at(18, 51) }), none).length, 0);
    // remote day
    assert.strictEqual(
        returnDue(mk({ plans: { today: plan(), tomorrow: null } }), none)
            .length,
        0,
    );
    // missing markers
    assert.strictEqual(
        returnDue(mk({ lastDepartureAt: null }), none).length,
        0,
    );
    assert.strictEqual(returnDue(mk({ returnedAt: null }), none).length, 0);
    // delivered before departure / not delivered: no line
    assert.strictEqual(
        returnDue(
            mk({
                parcels: [
                    parcel({ status: 'delivered', updatedAt: at(7).getTime() }),
                ],
            }),
            none,
        ).length,
        0,
    );
    assert.strictEqual(
        returnDue(
            mk({
                parcels: [
                    parcel({
                        status: 'out_for_delivery',
                        updatedAt: at(14).getTime(),
                    }),
                ],
            }),
            none,
        ).length,
        0,
    );
    // done
    assert.strictEqual(
        returnDue(mk(), (k) => k.startsWith('retour:')).length,
        0,
    );
}

// --- dueReminders: ordering and done ---
{
    const c = ctx({
        now: at(9, 5),
        events: [visio({ title: 'Call', start: '09:10' })],
        parcels: [parcel({ status: 'delivered' })],
    });
    const all = dueReminders(c, none);
    assert.deepStrictEqual(
        all.map((r) => r.type),
        ['morning', 'agenda-imminent', 'parcel'],
    );
    const skipped = dueReminders(c, (k) => k.startsWith('parcel:'));
    assert.strictEqual(skipped.length, 2);
}

console.log('policies.test.ts ok');
