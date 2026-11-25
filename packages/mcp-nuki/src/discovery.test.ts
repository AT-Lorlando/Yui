import assert from 'assert';
import { isStale, toEntity, DOOR_STATE_TTL_MS } from './discovery';

function run(): void {
    const e = toEntity(
        {
            nukiId: 42,
            name: 'Porte',
            deviceType: 4,
            lastKnownState: {
                stateName: 'unlocked',
                batteryCritical: false,
                doorsensorStateName: 'door closed',
            },
        },
        '2026-11-25T10:00:00.000Z',
    );
    assert.strictEqual(e.id, 42);
    assert.strictEqual(e.state.stateName, 'unlocked');
    assert.strictEqual(e.state.doorState, 'door closed');
    assert.strictEqual(
        toEntity({ nukiId: 1, name: 'X' }, 'now').state.stateName,
        'unknown',
    );

    assert.ok(isStale(0, 10_000));
    assert.ok(!isStale(10_000, 10_000 + DOOR_STATE_TTL_MS - 1));
    assert.ok(isStale(10_000, 10_000 + DOOR_STATE_TTL_MS));
    console.log('discovery.test.ts ok');
}

run();
