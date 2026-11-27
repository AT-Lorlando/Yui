import assert from 'assert';
import { normalizeWakeup } from './model';
import { decide, occKey } from './decide';
import type { Occurrence } from './occurrences';

const at = (h: number, m: number, s = 0) =>
    new Date(2026, 10, 27, h, m, s).getTime();
const mk = (extra: Record<string, unknown> = {}): Occurrence => ({
    wakeupId: 'x',
    at: at(7, 0),
    source: 'fixed',
    date: '2026-11-27',
    wakeup: normalizeWakeup({
        id: 'x',
        name: 'X',
        trigger: { kind: 'fixed', time: '07:00', days: [5] },
        ...extra,
    }),
});

function run() {
    const o = mk();
    assert.strictEqual(occKey(o), `2026-11-27@${o.at}`);
    assert.deepStrictEqual(decide(o, {}, at(6, 44)), []);
    assert.deepStrictEqual(decide(o, {}, at(6, 45)), [
        { kind: 'lights', rampMs: 900_000 },
    ]);
    assert.deepStrictEqual(decide(o, {}, at(6, 58)), [
        { kind: 'lights', rampMs: 120_000 },
    ]);
    assert.deepStrictEqual(decide(o, {}, at(6, 59, 30)), [
        { kind: 'lights', rampMs: 60_000 },
    ]);
    assert.deepStrictEqual(decide(o, {}, at(7, 5)), [{ kind: 'brief' }]);
    assert.deepStrictEqual(decide(o, {}, at(7, 20)), [{ kind: 'brief' }]);
    // fenêtre du point : B ≤ now < B + 30 min (afterMin 5 : jusqu'à 07:35)
    assert.deepStrictEqual(decide(o, {}, at(7, 31)), [{ kind: 'brief' }]);
    assert.deepStrictEqual(decide(o, {}, at(7, 36)), [{ kind: 'skip' }]);
    assert.deepStrictEqual(decide(o, { brief: 1 }, at(7, 31)), []);
    assert.deepStrictEqual(decide(o, { skipped: true }, at(7, 36)), []);
    // afterMin 40 : le point part quand même, skip seulement après B + 30
    const late = mk({
        brief: { afterMin: 40, speak: 'Chambre', notify: true },
    });
    assert.deepStrictEqual(decide(late, {}, at(7, 40)), [{ kind: 'brief' }]);
    assert.deepStrictEqual(decide(late, {}, at(7, 35)), []);
    assert.deepStrictEqual(decide(late, {}, at(8, 9)), [{ kind: 'brief' }]);
    assert.deepStrictEqual(decide(late, {}, at(8, 11)), [{ kind: 'skip' }]);
    assert.deepStrictEqual(decide(o, { lights: 1, brief: 2 }, at(7, 10)), []);
    // lumières déjà marquées : pas de seconde montée
    assert.deepStrictEqual(decide(o, { lights: 1 }, at(6, 50)), []);
    const nol = mk({ lights: null });
    assert.deepStrictEqual(decide(nol, {}, at(6, 50)), []);
    const nob = mk({ brief: null });
    assert.deepStrictEqual(decide(nob, {}, at(7, 5)), []);
    console.log('decide.test.ts ok');
}
run();
