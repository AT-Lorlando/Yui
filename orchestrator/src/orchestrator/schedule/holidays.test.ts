import assert from 'assert';
import { frenchHolidays, holidayName, isWorkday, weekdayOf } from './holidays';

function run() {
    const h26 = frenchHolidays(2026);
    assert.strictEqual(h26.size, 11);
    assert.strictEqual(h26.get('2026-04-06'), 'Lundi de Pâques');
    assert.strictEqual(h26.get('2026-05-14'), 'Ascension');
    assert.strictEqual(h26.get('2026-05-25'), 'Lundi de Pentecôte');
    const h27 = frenchHolidays(2027);
    assert.ok(
        h27.has('2027-03-29') && h27.has('2027-05-06') && h27.has('2027-05-17'),
    );
    assert.strictEqual(holidayName('2026-12-25'), 'Noël');
    assert.strictEqual(holidayName('2026-12-24'), null);
    assert.strictEqual(weekdayOf('2026-11-26'), 4); // jeudi
    assert.strictEqual(isWorkday('2026-11-26'), true);
    assert.strictEqual(isWorkday('2026-11-28'), false); // samedi
    assert.strictEqual(isWorkday('2026-11-11'), false); // férié un mercredi
    console.log('holidays.test.ts ok');
}
run();
