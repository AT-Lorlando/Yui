import assert from 'assert';
import { CalendarRule } from './model';
import { occurrences, nextOccurrences } from './occurrences';

function rule(p: Partial<CalendarRule>): CalendarRule {
    return {
        id: 'r',
        title: 't',
        kind: 'last-workday-month',
        enabled: true,
        allDay: true,
        calendarId: 'primary',
        start: '2000-01-01',
        ...p,
    } as CalendarRule;
}
const occ = (r: Partial<CalendarRule>, a: string, b: string) =>
    occurrences(rule(r), a, b);

assert.deepStrictEqual(
    occ({ kind: 'last-workday-month' }, '2026-01-01', '2026-06-30'),
    [
        '2026-01-30',
        '2026-02-27',
        '2026-03-31',
        '2026-04-30',
        '2026-05-29',
        '2026-06-30',
    ],
);
assert.deepStrictEqual(
    occ({ kind: 'last-workday-month' }, '2026-10-01', '2026-10-31'),
    ['2026-10-30'],
);

assert.deepStrictEqual(
    occ({ kind: 'first-workday-month' }, '2026-05-01', '2026-05-31'),
    ['2026-05-04'],
);
assert.deepStrictEqual(
    occ({ kind: 'first-workday-month' }, '2027-01-01', '2027-01-31'),
    ['2027-01-04'],
);

assert.deepStrictEqual(
    occ(
        { kind: 'workdays-before-month-end', n: 3 },
        '2026-11-01',
        '2026-11-30',
    ),
    ['2026-11-25'],
);

assert.deepStrictEqual(
    occ(
        { kind: 'day-of-month', day: 31, shift: 'none' },
        '2026-04-01',
        '2026-04-30',
    ),
    ['2026-04-30'],
);
assert.deepStrictEqual(
    occ(
        { kind: 'day-of-month', day: 25, shift: 'before' },
        '2026-04-01',
        '2026-04-30',
    ),
    ['2026-04-24'],
);
assert.deepStrictEqual(
    occ(
        { kind: 'day-of-month', day: 1, shift: 'after' },
        '2026-05-01',
        '2026-05-31',
    ),
    ['2026-05-04'],
);
assert.deepStrictEqual(
    occ(
        { kind: 'day-of-month', day: 31, shift: 'after' },
        '2026-01-01',
        '2026-02-28',
    ),
    ['2026-02-02'],
);

assert.deepStrictEqual(
    occ(
        { kind: 'nth-weekday-month', n: 2, weekday: 2 },
        '2026-12-01',
        '2026-12-31',
    ),
    ['2026-12-08'],
);
assert.deepStrictEqual(
    occ(
        { kind: 'nth-weekday-month', n: -1, weekday: 5 },
        '2026-07-01',
        '2026-07-31',
    ),
    ['2026-07-31'],
);
assert.deepStrictEqual(
    occ(
        { kind: 'nth-weekday-month', n: 5, weekday: 1 },
        '2026-02-01',
        '2026-02-28',
    ),
    [],
);

assert.deepStrictEqual(
    occ(
        { kind: 'every-n-weeks', n: 2, weekdays: [1], anchor: '2026-11-30' },
        '2026-11-30',
        '2026-12-31',
    ),
    ['2026-11-30', '2026-12-14', '2026-12-28'],
);
assert.deepStrictEqual(
    occ(
        { kind: 'every-n-weeks', n: 2, weekdays: [1], anchor: '2026-11-30' },
        '2026-11-01',
        '2026-11-29',
    ),
    [],
);

assert.deepStrictEqual(
    occ({ kind: 'last-workday-quarter' }, '2026-01-01', '2026-12-31'),
    ['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31'],
);

assert.deepStrictEqual(
    occ(
        { kind: 'yearly', month: 2, day: 29, shift: 'none' },
        '2027-01-01',
        '2027-12-31',
    ),
    ['2027-02-28'],
);
assert.deepStrictEqual(
    occ(
        { kind: 'yearly', month: 2, day: 29, shift: 'before' },
        '2027-01-01',
        '2027-12-31',
    ),
    ['2027-02-26'],
);
assert.deepStrictEqual(
    occ(
        { kind: 'yearly', month: 2, day: 29, shift: 'none' },
        '2028-01-01',
        '2028-12-31',
    ),
    ['2028-02-29'],
);

// start / until clipping (inclusive)
assert.deepStrictEqual(
    occ(
        {
            kind: 'last-workday-month',
            start: '2026-02-27',
            until: '2026-04-30',
        },
        '2026-01-01',
        '2026-12-31',
    ),
    ['2026-02-27', '2026-03-31', '2026-04-30'],
);
assert.deepStrictEqual(
    occ({ kind: 'last-workday-month' }, '2026-06-01', '2026-05-01'),
    [],
);

const next = nextOccurrences(
    rule({ kind: 'last-workday-month' }),
    '2026-11-27',
    6,
);
assert.strictEqual(next.length, 6);
assert.strictEqual(next[0], '2026-11-30');
assert.ok(next.every((d) => d >= '2026-11-27'));
assert.deepStrictEqual(next, [...next].sort());

console.log('occurrences.test ok');
