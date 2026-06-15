// packages/mcp-hue/src/GoveeAmbiance.test.ts
import assert from 'assert';
import { startAmbiance, stopAmbiance, listAmbiance } from './GoveeAmbiance';
import type GoveeClient from './GoveeClient';

/** Minimal GoveeClient stand-in counting the commands the loop emits. */
function fakeClient() {
    const calls = { color: 0, brightness: 0 };
    const client = {
        color: async () => {
            calls.color++;
        },
        brightness: async () => {
            calls.brightness++;
        },
        on: async () => {},
    } as unknown as GoveeClient;
    return { client, calls };
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function testStopHaltsTheLoop(): Promise<void> {
    const { client, calls } = fakeClient();

    // "rave" has the smallest stepMs (200ms) → fastest to observe ticks.
    startAmbiance('test-device', 'rave', client);
    assert.ok(
        calls.color >= 1,
        'startAmbiance should emit an immediate first frame',
    );
    assert.ok(
        listAmbiance().some((p) => p.id === 'rave' && p.running),
        'rave should report as running',
    );

    // Let a few ticks accumulate, then stop.
    await sleep(450);
    const stopped = stopAmbiance('test-device');
    assert.strictEqual(stopped, true, 'stopAmbiance should report it stopped');
    assert.strictEqual(
        stopAmbiance('test-device'),
        false,
        'second stop is a no-op',
    );

    // After stopping, no further commands must be emitted.
    const frozen = calls.color;
    await sleep(450);
    assert.strictEqual(
        calls.color,
        frozen,
        'no color commands should be sent after stop',
    );
    assert.ok(
        !listAmbiance().some((p) => p.running),
        'nothing should report as running after stop',
    );
}

async function run(): Promise<void> {
    await testStopHaltsTheLoop();
    console.log('All GoveeAmbiance tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
