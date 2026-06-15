// orchestrator/src/orchestrator/animation/animationManager.test.ts
import assert from 'assert';
import {
    animationManager,
    computeTickInterval,
    floatingFrameColors,
    shouldCancel,
} from './animationManager';
import type { FloatingConfig } from './types';

// stopAll() must wait for the latest tick's in-flight set_lights commands to
// settle before resolving — otherwise a following off command races them on the
// bridge and the floating "on" frames re-light the room.
async function testStopAllDrainsInFlight(): Promise<void> {
    const cfg: FloatingConfig = {
        engine: 'software',
        target: 'Salon',
        palette: ['#FF0000', '#00FF00'],
        speedSec: 10,
    };
    let releaseInFlight!: () => void;
    const inFlightGate = new Promise<void>((r) => {
        releaseInFlight = r;
    });
    let setLightsCount = 0;
    let setLightsDone = false;
    const callTool = async (tool: string): Promise<unknown> => {
        if (tool === 'list_lights') return [{ name: 'L1', room: 'Salon' }];
        // Simulate a slow in-flight set_lights request to the bridge.
        setLightsCount++;
        await inFlightGate;
        setLightsDone = true;
        return null;
    };

    await animationManager.startFloating(cfg, callTool);
    assert.ok(
        setLightsCount > 0,
        'first tick should have dispatched set_lights',
    );

    let stopResolved = false;
    const stopP = animationManager.stopAll().then(() => {
        stopResolved = true;
    });

    // The in-flight command has not settled yet → stopAll must still be pending.
    await Promise.resolve();
    assert.strictEqual(
        stopResolved,
        false,
        'stopAll resolved before draining in-flight commands',
    );

    releaseInFlight();
    await stopP;
    assert.strictEqual(stopResolved, true);
    assert.strictEqual(setLightsDone, true);
}

async function run(): Promise<void> {
    // throttle: 5 lights at 8 cmd/s → need ≥ 625ms, but floor is MIN_TICK_MS
    assert.strictEqual(computeTickInterval(5, 8, 800), 800);
    assert.strictEqual(computeTickInterval(20, 8, 800), 2500);

    // floating: each light gets a colour; stagger shifts phase so they differ
    const cfg: FloatingConfig = {
        engine: 'software',
        target: 'Salon',
        palette: ['#FF0000', '#0000FF'],
        speedSec: 10,
        staggerSec: 2.5,
    };
    const colors = floatingFrameColors(cfg, ['A', 'B'], 0);
    assert.ok(colors.A && colors.B);
    assert.notStrictEqual(colors.A.color, colors.B.color); // phase offset → different

    // lifecycle: any light-affecting tool cancels an active loop
    assert.strictEqual(shouldCancel('set_lights'), true);
    assert.strictEqual(shouldCancel('turn_off_all_lights'), true);
    assert.strictEqual(shouldCancel('_lights_palette'), true);
    assert.strictEqual(shouldCancel('house_off'), true);
    assert.strictEqual(shouldCancel('play_music'), false);
    assert.strictEqual(shouldCancel('cast_netflix'), false);

    await testStopAllDrainsInFlight();

    console.log('All animationManager tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
