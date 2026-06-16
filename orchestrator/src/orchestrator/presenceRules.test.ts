import assert from 'assert';
import {
    rulesForEvent,
    seedRules,
    validateRules,
    type PresenceRule,
} from './presenceRules';

function run(): void {
    const rules: PresenceRule[] = [
        { id: 'a', name: 'A', enabled: true, trigger: 'arrival', actions: [] },
        { id: 'b', name: 'B', enabled: false, trigger: 'arrival', actions: [] },
        {
            id: 'c',
            name: 'C',
            enabled: true,
            trigger: 'network-join',
            actions: [],
        },
    ];
    assert.deepStrictEqual(
        rulesForEvent(rules, 'arrival').map((r) => r.id),
        ['a'],
    );
    assert.deepStrictEqual(
        rulesForEvent(rules, 'network-join').map((r) => r.id),
        ['c'],
    );
    assert.deepStrictEqual(
        rulesForEvent(rules, 'departure').map((r) => r.id),
        [],
    );

    {
        const seeded = seedRules('retour-maison', 'depart-maison');
        const arrival = seeded.find((r) => r.trigger === 'arrival');
        const departure = seeded.find((r) => r.trigger === 'departure');
        assert.ok(arrival && arrival.actions[0].tool === 'scene_trigger');
        assert.strictEqual(
            (arrival!.actions[0].args as any).id,
            'retour-maison',
        );
        assert.ok(
            departure &&
                (departure.actions[0].args as any).id === 'depart-maison',
        );
        assert.ok(seeded.some((r) => r.trigger === 'network-join'));
    }
    {
        const seeded = seedRules(undefined, undefined);
        assert.ok(!seeded.some((r) => r.trigger === 'arrival'));
        assert.ok(seeded.some((r) => r.trigger === 'network-join'));
    }

    assert.throws(() =>
        validateRules([
            {
                id: 'x',
                name: 'X',
                enabled: true,
                trigger: 'bad',
                actions: [],
            } as any,
        ]),
    );
    assert.throws(() =>
        validateRules([
            {
                id: 'x',
                name: 'X',
                enabled: true,
                trigger: 'arrival',
                actions: [],
            },
            {
                id: 'x',
                name: 'Y',
                enabled: true,
                trigger: 'arrival',
                actions: [],
            },
        ]),
    );
    assert.throws(() =>
        validateRules([
            {
                id: 'x',
                name: 'X',
                enabled: true,
                trigger: 'arrival',
                actions: {},
            } as any,
        ]),
    );
    assert.strictEqual(validateRules(rules).length, 3);

    console.log('All presenceRules tests passed');
}

run();
