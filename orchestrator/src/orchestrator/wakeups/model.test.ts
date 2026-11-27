import assert from 'assert';
import { DEFAULT_WAKEUPS, normalizeWakeup, normalizeWakeups } from './model';

function run() {
    const w = normalizeWakeup({
        id: 'a',
        name: 'A',
        trigger: { kind: 'phone' },
    });
    assert.strictEqual(w.enabled, true);
    assert.strictEqual(w.lights?.rampMin, 15);
    assert.strictEqual(w.lights?.room, 'Chambre');
    assert.strictEqual(w.brief?.afterMin, 5);
    assert.strictEqual(w.brief?.speak, 'Chambre');

    const n = normalizeWakeup({
        id: 'b',
        name: 'B',
        lights: null,
        brief: null,
        trigger: { kind: 'fixed', time: '07:00', days: [5, 1, 1, 3] },
    });
    assert.strictEqual(n.lights, null);
    assert.strictEqual(n.brief, null);
    assert.deepStrictEqual((n.trigger as { days: number[] }).days, [1, 3, 5]);

    const bad = (o: object) =>
        assert.throws(() =>
            normalizeWakeup({
                id: 'a',
                name: 'A',
                trigger: { kind: 'phone' },
                ...o,
            }),
        );
    bad({ id: 'A B' });
    bad({ name: '' });
    bad({ trigger: { kind: 'fixed', time: '07:00', days: [] } });
    bad({ trigger: { kind: 'fixed', time: '7h', days: [1] } });
    bad({ trigger: { kind: 'fixed', time: '07:00', days: [7] } });
    bad({ lights: { toBrightness: 0 } });
    bad({ lights: { rampMin: 61 } });
    bad({ lights: { from: 'red' } });
    bad({ lights: { to: 1000 } });
    bad({ brief: { afterMin: 61 } });
    bad({ brief: { speak: '' } });

    assert.strictEqual(
        normalizeWakeup({
            id: 'a',
            name: 'A',
            trigger: { kind: 'phone' },
            brief: { speak: null },
        }).brief?.speak,
        null,
    );

    assert.throws(
        () =>
            normalizeWakeups([
                { id: 'a', name: 'A', trigger: { kind: 'phone' } },
                { id: 'a', name: 'B', trigger: { kind: 'phone' } },
            ]),
        /unique|doublon/i,
    );
    assert.throws(() =>
        normalizeWakeups(
            Array.from({ length: 11 }, (_, i) => ({
                id: `w${i}`,
                name: 'x',
                trigger: { kind: 'phone' },
            })),
        ),
    );
    assert.throws(
        () =>
            normalizeWakeups([
                { id: 'a', name: 'A', trigger: { kind: 'phone' } },
                { id: 'b', name: 'B', trigger: { kind: 'phone' } },
            ]),
        /Un seul réveil peut suivre le téléphone/,
    );
    assert.strictEqual(
        normalizeWakeups([
            { id: 'a', name: 'A', trigger: { kind: 'phone' } },
            {
                id: 'b',
                name: 'B',
                trigger: { kind: 'fixed', time: '07:00', days: [1] },
            },
        ]).length,
        2,
    );
    assert.strictEqual(DEFAULT_WAKEUPS.length, 1);
    assert.strictEqual(DEFAULT_WAKEUPS[0].id, 'semaine');
    console.log('model.test.ts ok');
}
run();
