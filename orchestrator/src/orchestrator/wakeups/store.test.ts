import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-wakeups-'));
process.env.YUI_DATA_DIR = tmp;
const cfg = path.join(tmp, 'config', 'wakeups.json');

const store = require('./store') as typeof import('./store');
const { DEFAULT_WAKEUPS } = require('./model') as typeof import('./model');

function run() {
    assert.deepStrictEqual(store.readWakeups(), DEFAULT_WAKEUPS);
    assert.strictEqual(fs.existsSync(cfg), false);
    assert.strictEqual(store.readPhoneAlarm(), null);

    const out = store.writeWakeups([
        {
            id: 'x',
            name: 'X',
            trigger: { kind: 'fixed', time: '06:45', days: [1, 2] },
        },
    ]);
    assert.strictEqual(out[0].lights?.rampMin, 15);
    assert.deepStrictEqual(store.readWakeups(), out);
    assert.throws(() => store.writeWakeups([{ id: 'A B' }]));
    assert.deepStrictEqual(store.readWakeups(), out);

    assert.throws(() => store.writePhoneAlarm('x'));
    assert.throws(() => store.writePhoneAlarm(NaN));
    const a = store.writePhoneAlarm(1000, 'android', 5);
    assert.deepStrictEqual(a, {
        nextAt: 1000,
        reportedAt: 5,
        source: 'android',
    });
    assert.deepStrictEqual(store.readPhoneAlarm(), a);
    const b = store.writePhoneAlarm(null);
    assert.strictEqual(b.nextAt, null);
    assert.strictEqual(store.readPhoneAlarm()?.nextAt, null);

    fs.writeFileSync(cfg, '{oops');
    assert.deepStrictEqual(store.readWakeups(), DEFAULT_WAKEUPS);
    console.log('store.test.ts ok');
}
run();
