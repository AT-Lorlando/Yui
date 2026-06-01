// orchestrator/src/orchestrator/animation/effects.test.ts
import assert from 'assert';
import { expandEffect, expandIntro } from './effects';
import type { AnimationEffect } from './types';

function run(): void {
    const lights = ['L1', 'L2', 'L3'];

    // sweep: staggered keyframes, one per light
    const sweep: AnimationEffect = {
        type: 'sweep',
        target: 'Salon',
        colors: ['#00FF00'],
        staggerMs: 150,
        transitionMs: 400,
    };
    const r = expandEffect(sweep, lights, 0);
    assert.strictEqual(r.frames.length, 3);
    assert.deepStrictEqual(
        r.frames.map((f) => f.atMs),
        [0, 150, 300],
    );
    assert.strictEqual(r.frames[2].lightName, 'L3');
    assert.strictEqual(r.frames[0].color, '#00FF00');
    // end = last start (300) + transition (400)
    assert.strictEqual(r.endMs, 700);

    // expandIntro: overlap via startAtMs (blue starts before green ends)
    const green: AnimationEffect = { ...sweep };
    const blue: AnimationEffect = {
        type: 'sweep',
        target: 'Salon',
        colors: ['#0066FF'],
        startAtMs: 200,
        staggerMs: 150,
        transitionMs: 400,
    };
    const intro = expandIntro([green, blue], () => lights);
    // green ends at 700; blue starts at 200 and ends at 900 → overlap, total is max
    assert.strictEqual(intro.totalMs, 900);
    // frames sorted by atMs; blue's first frame at 200 sits between green frames
    assert.deepStrictEqual(
        intro.frames.map((f) => f.atMs),
        [0, 150, 200, 300, 350, 500],
    );

    // chaining: no startAtMs → second effect starts at previous end
    const flash: AnimationEffect = {
        type: 'flash',
        target: 'Salon',
        colors: ['#FFFFFF'],
        transitionMs: 100,
    };
    const chained = expandIntro([green, flash], () => lights);
    // green ends at 700 → flash frames all at 700
    assert.ok(
        chained.frames
            .filter((f) => f.color === '#FFFFFF')
            .every((f) => f.atMs === 700),
    );

    console.log('All effects tests passed');
}

run();
