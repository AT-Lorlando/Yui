import assert from 'assert';
import { normalizeRule, RULE_KINDS } from './model';

const today = '2026-11-27';
const base = { title: ' Facture ', kind: 'last-workday-month' };
const bad = (raw: unknown, msg: RegExp | string) =>
    assert.throws(
        () => normalizeRule(raw, { today }),
        (e: Error) =>
            typeof msg === 'string' ? e.message === msg : msg.test(e.message),
    );

assert.strictEqual(RULE_KINDS.length, 8);

const r = normalizeRule(
    { ...base, n: 3, day: 4, weekday: 2, shift: 'after' },
    { today },
);
assert.strictEqual(r.title, 'Facture');
assert.strictEqual(r.allDay, true);
assert.strictEqual(r.calendarId, 'primary');
assert.strictEqual(r.start, today);
assert.strictEqual(r.enabled, true);
assert.strictEqual(r.time, undefined);
assert.strictEqual(r.n, undefined);
assert.strictEqual(r.day, undefined);
assert.strictEqual(r.weekday, undefined);
assert.strictEqual(r.shift, undefined);
assert.ok(/^[a-z0-9-]+-[a-z0-9]{6}$/.test(r.id), r.id);
assert.ok(r.id.startsWith('facture-'));
assert.strictEqual(normalizeRule(base, { today, id: 'x1' }).id, 'x1');

const d = normalizeRule(
    { title: 'A', kind: 'day-of-month', day: 15 },
    { today },
);
assert.strictEqual(d.shift, 'before');
assert.strictEqual(d.day, 15);

const t = normalizeRule({ ...base, allDay: false, time: '09:30' }, { today });
assert.strictEqual(t.durationMin, 60);
assert.strictEqual(t.time, '09:30');
const t2 = normalizeRule(
    { ...base, allDay: true, time: '09:30', durationMin: 30 },
    { today },
);
assert.strictEqual(t2.time, undefined);
assert.strictEqual(t2.durationMin, undefined);

const w = normalizeRule(
    {
        title: 'W',
        kind: 'every-n-weeks',
        n: 2,
        weekdays: [3, 1, 3],
        start: '2026-12-01',
    },
    { today },
);
assert.deepStrictEqual(w.weekdays, [1, 3]);
assert.strictEqual(w.anchor, '2026-12-01');

const y = normalizeRule(
    { title: 'Y', kind: 'yearly', month: 2, day: 29 },
    { today },
);
assert.strictEqual(y.shift, 'before');

bad(null, 'Règle invalide');
bad({ ...base, title: '  ' }, 'Titre requis');
bad({ ...base, title: 'x'.repeat(121) }, /Titre/);
bad({ ...base, kind: 'x' }, 'Type inconnu : x');
bad({ ...base, allDay: false }, /Heure invalide/);
bad({ ...base, allDay: false, time: '25:00' }, 'Heure invalide : 25:00');
bad(
    { ...base, allDay: false, time: '09:00', durationMin: 2 },
    'Durée invalide',
);
bad({ ...base, calendarId: '' }, /Agenda/);
bad({ ...base, description: 'x'.repeat(501) }, /Description/);
bad({ ...base, start: '2026-02-30' }, 'Date invalide : 2026-02-30');
bad({ ...base, until: '2026-11-01' }, 'Fin avant le début');
bad({ title: 'a', kind: 'workdays-before-month-end', n: 16 }, /jours ouvrés/i);
bad({ title: 'a', kind: 'day-of-month', day: 32 }, /Jour invalide/);
bad(
    { title: 'a', kind: 'day-of-month', day: 3, shift: 'x' },
    /Décalage invalide/,
);
bad(
    { title: 'a', kind: 'nth-weekday-month', n: 0, weekday: 1 },
    /Rang invalide/,
);
bad(
    { title: 'a', kind: 'nth-weekday-month', n: 1, weekday: 7 },
    /Jour de semaine invalide/,
);
bad(
    { title: 'a', kind: 'every-n-weeks', n: 9, weekdays: [1] },
    /Intervalle invalide/,
);
bad(
    { title: 'a', kind: 'every-n-weeks', n: 2, weekdays: [] },
    /Jours de semaine requis/,
);
bad({ title: 'a', kind: 'yearly', month: 13, day: 1 }, /Mois invalide/);

console.log('model.test ok');
