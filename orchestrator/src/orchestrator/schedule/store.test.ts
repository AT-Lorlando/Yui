import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-schedule-'));
process.env.YUI_DATA_DIR = tmp;
const file = path.join(tmp, 'config', 'schedule.json');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require('./store') as typeof import('./store');

function run() {
    // lecture sans fichier : défaut, rien d'écrit
    const s0 = store.readSchedule('2026-11-26');
    assert.strictEqual(s0.week['4'].mode, 'remote');
    assert.strictEqual(fs.existsSync(file), false);

    // semaine incomplète refusée
    const six: Record<string, unknown> = {};
    for (const k of ['0', '1', '2', '3', '4', '5']) six[k] = { mode: 'remote' };
    assert.throws(() => store.setWeek(six));

    // semaine valide relue
    const week: Record<string, unknown> = { ...six, '6': { mode: 'off' } };
    week['2'] = { mode: 'onsite', leave: '08:00', back: '18:00' };
    store.setWeek(week);
    const s1 = store.readSchedule('2026-11-26');
    assert.deepStrictEqual(s1.week['2'], {
        mode: 'onsite',
        leave: '08:00',
        back: '18:00',
    });
    assert.strictEqual(s1.week['6'].mode, 'off');

    // exceptions
    let s = store.upsertException(
        { date: '2026-12-03', mode: 'onsite' },
        '2026-11-26',
    );
    assert.strictEqual(s.exceptions.length, 1);
    assert.strictEqual(s.exceptions[0].leave, '08:30');
    s = store.upsertException(
        { date: '2026-12-03', mode: 'off' },
        '2026-11-26',
    );
    assert.strictEqual(s.exceptions.length, 1);
    assert.strictEqual(s.exceptions[0].mode, 'off');
    s = store.upsertException(
        { date: '2026-12-01', mode: 'off' },
        '2026-11-26',
    );
    assert.deepStrictEqual(
        s.exceptions.map((e) => e.date),
        ['2026-12-01', '2026-12-03'],
    );
    assert.throws(
        () =>
            store.upsertException(
                { date: '2026-11-25', mode: 'off' },
                '2026-11-26',
            ),
        /pass/,
    );

    // purge des exceptions passées, persistée
    const s2 = store.readSchedule('2026-12-02');
    assert.deepStrictEqual(
        s2.exceptions.map((e) => e.date),
        ['2026-12-03'],
    );
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(onDisk.exceptions.length, 1);

    // suppression
    assert.strictEqual(store.removeException('2026-01-01'), null);
    assert.strictEqual(
        store.removeException('2026-12-03')?.exceptions.length,
        0,
    );

    // JSON illisible : défaut
    fs.writeFileSync(file, '{oops');
    assert.strictEqual(
        store.readSchedule('2026-11-26').week['2'].mode,
        'remote',
    );

    console.log('store.test.ts ok');
}
run();
