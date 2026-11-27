import assert from 'assert';
import { normalizeWakeup } from './model';
import { nextFixed, pickMornings, usablePhoneAlarm } from './occurrences';

const now = new Date(2026, 10, 26, 22, 0).getTime();
const at = (d: number, h: number, m = 0, mo = 10) =>
    new Date(2026, mo, d, h, m).getTime();
const phone = (nextAt: number | null) => ({
    nextAt,
    reportedAt: now,
    source: 't',
});
const wPhone = normalizeWakeup({
    id: 'p',
    name: 'P',
    trigger: { kind: 'phone' },
});
const wFixed = normalizeWakeup({
    id: 'f',
    name: 'F',
    trigger: { kind: 'fixed', time: '07:00', days: [1, 2, 3, 4, 5] },
});

function run() {
    let r = pickMornings([wPhone], phone(at(27, 7)), now);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].source, 'phone');
    assert.strictEqual(r[0].date, '2026-11-27');
    assert.strictEqual(r[0].wakeupId, 'p');

    assert.strictEqual(usablePhoneAlarm(phone(at(27, 13)), now), null);
    assert.strictEqual(usablePhoneAlarm(phone(at(27, 2, 30)), now), null);
    assert.strictEqual(usablePhoneAlarm(phone(at(27, 3)), now), at(27, 3));
    assert.strictEqual(
        usablePhoneAlarm(phone(at(27, 11, 59)), now),
        at(27, 11, 59),
    );
    assert.strictEqual(usablePhoneAlarm(phone(now + 25 * 3600e3), now), null);
    assert.strictEqual(usablePhoneAlarm(phone(now - 1000), now), null);
    assert.strictEqual(usablePhoneAlarm(null, now), null);
    assert.strictEqual(usablePhoneAlarm(phone(null), now), null);

    r = pickMornings([wFixed, wPhone], phone(at(27, 7, 3)), now);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].source, 'fixed');
    assert.strictEqual(r[0].at, at(27, 7));
    assert.strictEqual(r[0].wakeupId, 'f');

    r = pickMornings([wFixed, wPhone], phone(at(27, 6, 30)), now);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].source, 'phone');
    assert.strictEqual(r[0].at, at(27, 6, 30));

    assert.deepStrictEqual(pickMornings([wPhone], phone(null), now), []);
    assert.deepStrictEqual(
        pickMornings([{ ...wPhone, enabled: false }], phone(at(27, 7)), now),
        [],
    );

    // vendredi 22h -> lundi
    const fri = new Date(2026, 10, 27, 22, 0).getTime();
    assert.strictEqual(nextFixed(wFixed, fri), at(30, 7));
    // même jour, heure déjà passée -> strictement > now
    assert.strictEqual(nextFixed(wFixed, at(27, 7)), at(30, 7));
    assert.strictEqual(nextFixed(wPhone, now), null);

    // changement d'heure
    const sun = normalizeWakeup({
        id: 's',
        name: 'S',
        trigger: { kind: 'fixed', time: '07:00', days: [0] },
    });
    assert.strictEqual(
        nextFixed(sun, new Date(2026, 9, 24, 22, 0).getTime()),
        new Date(2026, 9, 25, 7, 0).getTime(),
    );

    // tri, une par date
    const wLate = normalizeWakeup({
        id: 'l',
        name: 'L',
        trigger: { kind: 'fixed', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] },
    });
    r = pickMornings([wLate, wFixed], null, now);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].wakeupId, 'f');
    console.log('occurrences.test.ts ok');
}
run();
