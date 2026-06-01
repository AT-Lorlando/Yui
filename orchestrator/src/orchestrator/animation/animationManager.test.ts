// orchestrator/src/orchestrator/animation/animationManager.test.ts
import assert from 'assert';
import {
    computeTickInterval,
    floatingFrameColors,
    shouldCancel,
} from './animationManager';
import type { FloatingConfig } from './types';

function run(): void {
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

    console.log('All animationManager tests passed');
}

run();
