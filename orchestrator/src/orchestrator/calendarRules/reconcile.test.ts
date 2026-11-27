import assert from 'assert';
import { CalendarRule, normalizeRule } from './model';
import { occurrences } from './occurrences';
import { planReconcile, TaggedEvent } from './reconcile';
import { addDays } from '../schedule/dayPlan';

const now = new Date(2026, 10, 27, 10, 0);
const today = '2026-11-27';
const horizonEnd = addDays(today, 92);

// Tous les jours ouvrés d'une semaine sur une : un lundi sur un, à 09:00
const weekly: CalendarRule = normalizeRule(
    {
        id: 'hebdo',
        title: 'Point',
        kind: 'every-n-weeks',
        n: 1,
        weekdays: [1, 2, 3, 4, 5],
        allDay: false,
        time: '09:00',
        durationMin: 30,
        start: '2026-01-01',
    },
    { today },
);
const monthly: CalendarRule = normalizeRule(
    {
        id: 'facture',
        title: 'Facture',
        kind: 'last-workday-month',
        start: '2026-01-01',
    },
    { today },
);

function evFor(
    rule: CalendarRule,
    date: string,
    over: Partial<TaggedEvent> = {},
): TaggedEvent {
    return {
        id: `${rule.id}-${date}`,
        calendarId: rule.calendarId,
        title: rule.title,
        date,
        allDay: rule.allDay,
        start: rule.allDay ? null : rule.time!,
        durationMin: rule.allDay ? null : rule.durationMin!,
        yuiRule: rule.id,
        yuiDate: date,
        ...over,
    };
}

const allFor = (rule: CalendarRule) =>
    occurrences(rule, today, horizonEnd).map((d) => evFor(rule, d));

// 1. Rien n'existe → toutes les occurrences sont créées
{
    const p = planReconcile([monthly, weekly], [], now);
    // Le minuté d'aujourd'hui à 09:00 est passé (il est 10:00) : pas créé.
    const expected =
        occurrences(monthly, today, horizonEnd).length +
        occurrences(weekly, today, horizonEnd).length -
        1;
    assert.strictEqual(p.create.length, expected);
    assert.strictEqual(p.update.length, 0);
    assert.strictEqual(p.remove.length, 0);
    const first = p.create.find((c) => c.ruleId === 'facture')!;
    assert.strictEqual(first.date, '2026-11-30');
    assert.strictEqual(first.allDay, true);
    assert.strictEqual(first.calendarId, 'primary');
    assert.strictEqual(first.title, 'Facture');
    const w = p.create.find((c) => c.ruleId === 'hebdo')!;
    assert.strictEqual(w.time, '09:00');
    assert.strictEqual(w.durationMin, 30);
    assert.ok(!p.create.some((c) => c.ruleId === 'hebdo' && c.date === today));
}

// 1b. Premier run du jour : minuté d'aujourd'hui passé → pas créé ;
//     encore à venir → créé ; journée entière d'aujourd'hui → créée
{
    const at10 = { ...weekly, id: 'a10', time: '10:00' };
    const at15 = { ...weekly, id: 'a15', time: '15:00' };
    const p = planReconcile([weekly, at10, at15], [], now);
    const todayIds = p.create
        .filter((c) => c.date === today)
        .map((c) => c.ruleId);
    assert.deepStrictEqual(todayIds, ['a15']);
    const daily = normalizeRule(
        {
            id: 'jour',
            title: 'Jour',
            kind: 'every-n-weeks',
            n: 1,
            weekdays: [0, 1, 2, 3, 4, 5, 6],
            start: '2026-01-01',
        },
        { today },
    );
    assert.ok(
        planReconcile([daily], [], now).create.some((c) => c.date === today),
    );
}

// 2. Tout correspond → rien
{
    const p = planReconcile(
        [monthly, weekly],
        [...allFor(monthly), ...allFor(weekly)],
        now,
    );
    assert.deepStrictEqual(p, { create: [], update: [], remove: [] });
}

// 3. Titre changé → update
{
    const renamed = { ...monthly, title: 'Facture mensuelle' };
    const p = planReconcile([renamed], allFor(monthly), now);
    assert.strictEqual(p.create.length, 0);
    assert.strictEqual(p.remove.length, 0);
    assert.strictEqual(p.update.length, allFor(monthly).length);
    assert.strictEqual(p.update[0].want.title, 'Facture mensuelle');
    assert.strictEqual(p.update[0].event.yuiRule, 'facture');
}

// 4. Heure changée → update (l'événement d'aujourd'hui à 09:00 est passé)
{
    const moved = { ...weekly, time: '14:00' };
    const existing = allFor(weekly);
    const p = planReconcile([moved], existing, now);
    assert.strictEqual(p.create.length, 0);
    assert.strictEqual(p.remove.length, 0);
    assert.strictEqual(p.update.length, existing.length - 1);
    assert.ok(p.update.every((u) => u.event.yuiDate > today));
    assert.ok(p.update.every((u) => u.want.time === '14:00'));
}

// 4b. Durée changée, passage journée entière → update
{
    const p = planReconcile(
        [{ ...weekly, durationMin: 45 }],
        allFor(weekly),
        now,
    );
    assert.strictEqual(p.update.length, allFor(weekly).length - 1);
    const p2 = planReconcile(
        [{ ...monthly, allDay: false, time: '08:00', durationMin: 60 }],
        allFor(monthly),
        now,
    );
    assert.strictEqual(p2.update.length, allFor(monthly).length);
}

// 5. Agenda changé → remove + create
{
    const other = { ...monthly, calendarId: 'pro@group.calendar.google.com' };
    const existing = allFor(monthly);
    const p = planReconcile([other], existing, now);
    assert.strictEqual(p.update.length, 0);
    assert.strictEqual(p.remove.length, existing.length);
    assert.strictEqual(p.create.length, existing.length);
    assert.ok(p.create.every((c) => c.calendarId === other.calendarId));
}

// 6. Règle désactivée → ses événements futurs sont retirés
{
    const p = planReconcile(
        [{ ...monthly, enabled: false }],
        allFor(monthly),
        now,
    );
    assert.strictEqual(p.create.length, 0);
    assert.strictEqual(p.remove.length, allFor(monthly).length);
}

// 7. Règle supprimée (id orphelin) → retiré
{
    const orphan = evFor(monthly, '2026-12-15', {
        yuiRule: 'disparue',
        id: 'o1',
    });
    const p = planReconcile([monthly], [...allFor(monthly), orphan], now);
    assert.deepStrictEqual(
        p.remove.map((e) => e.id),
        ['o1'],
    );
    assert.strictEqual(p.create.length, 0);
}

// 8. Événement passé : jamais touché
{
    const past = evFor(monthly, '2026-11-20', { id: 'past', title: 'Vieux' });
    const p = planReconcile([], [past], now);
    assert.deepStrictEqual(p, { create: [], update: [], remove: [] });
    const p2 = planReconcile([{ ...monthly, title: 'Autre' }], [past], now);
    assert.ok(!p2.update.some((u) => u.event.id === 'past'));
    assert.ok(!p2.remove.some((e) => e.id === 'past'));
}

// 9. Événement minuté d'aujourd'hui : 09:00 verrouillé, 15:00 retirable
{
    const at9 = evFor(weekly, today, {
        id: 'e9',
        yuiRule: 'disparue',
        start: '09:00',
    });
    const at15 = evFor(weekly, today, {
        id: 'e15',
        yuiRule: 'disparue2',
        start: '15:00',
    });
    const p = planReconcile([], [at9, at15], now);
    assert.deepStrictEqual(
        p.remove.map((e) => e.id),
        ['e15'],
    );
    // Journée entière aujourd'hui : verrouillée
    const ad = evFor(monthly, today, { id: 'ad', yuiRule: 'disparue' });
    assert.strictEqual(planReconcile([], [ad], now).remove.length, 0);
}

// 10. Doublon de clé → un seul retiré, celui qui correspond gardé
{
    const existing = allFor(monthly);
    const dupWrong = { ...existing[0], id: 'dup-wrong', title: 'Facturee' };
    const p = planReconcile([monthly], [dupWrong, ...existing], now);
    assert.deepStrictEqual(
        p.remove.map((e) => e.id),
        ['dup-wrong'],
    );
    assert.strictEqual(p.update.length, 0);
    assert.strictEqual(p.create.length, 0);
    // Deux doublons identiques : un seul retiré
    const dup = { ...existing[0], id: 'dup-same' };
    const p2 = planReconcile([monthly], [...existing, dup], now);
    assert.strictEqual(p2.remove.length, 1);
}

// 11. Au-delà de l'horizon : jamais touché
{
    const far = evFor(monthly, addDays(horizonEnd, 10), {
        id: 'far',
        yuiRule: 'disparue',
    });
    const p = planReconcile([monthly], [...allFor(monthly), far], now);
    assert.deepStrictEqual(p, { create: [], update: [], remove: [] });
}

console.log('calendarRules/reconcile.test OK');
