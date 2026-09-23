// orchestrator/src/orchestrator/animation/effects.test.ts
import assert from 'assert';
import { expandEffect, expandIntro } from './effects';
import type { AnimationEffect } from './types';

function testTemplates(): void {
    const four = ['A', 'B', 'C', 'D'];
    // loading : 1 rampe par lampe, depuis le noir, tout dans durationMs.
    const l = expandEffect(
        {
            type: 'loading',
            target: 'Chambre',
            colors: ['#0044ff'],
            durationMs: 1500,
        },
        four,
        0,
    );
    assert.strictEqual(l.frames.length, 4);
    assert.strictEqual(l.endMs, 1500);
    assert.ok(l.frames.every((f) => f.fadeFrom === 1 && f.brightness === 100));
    const starts = l.frames.map((f) => f.atMs);
    assert.ok(starts[1]! > starts[0]! && starts[3]! > starts[2]!, 'décalées');
    assert.ok(
        starts[3]! + l.frames[3]!.transitionMs <= 1500 + 5,
        'la dernière finit dans le budget',
    );
    // Même durée totale avec 12 lampes.
    const l12 = expandEffect(
        {
            type: 'loading',
            target: 'Salon',
            colors: ['#fff'],
            durationMs: 1500,
        },
        Array.from({ length: 12 }, (_, i) => `L${i}`),
        0,
    );
    assert.strictEqual(l12.frames.length, 12);
    assert.strictEqual(l12.endMs, 1500);
    // reverse : dernière lampe d'abord.
    const rev = expandEffect(
        {
            type: 'loading',
            target: 'x',
            colors: ['#fff'],
            durationMs: 1000,
            order: 'reverse',
        },
        four,
        0,
    );
    assert.strictEqual(rev.frames[0]!.lightName, 'D');
    // wave : balayage 1re couleur puis fondu global vers la 2e.
    const w = expandEffect(
        {
            type: 'wave',
            target: 'x',
            colors: ['#ff0000', '#0000ff'],
            durationMs: 2000,
        },
        four,
        0,
    );
    assert.strictEqual(w.frames.length, 8);
    assert.strictEqual(w.endMs, 2000);
    assert.ok(
        w.frames
            .filter((f) => f.color === '#0000ff')
            .every((f) => f.atMs === 1200),
    );
    // blink : count éclats × 2 frames × lampes.
    const b = expandEffect(
        {
            type: 'blink',
            target: 'x',
            colors: ['#fff'],
            durationMs: 1000,
            count: 3,
        },
        four,
        0,
    );
    assert.strictEqual(b.frames.length, 3 * 2 * 4);
    assert.strictEqual(b.endMs, 1000);
    // breathe : montée puis descente.
    const br = expandEffect(
        {
            type: 'breathe',
            target: 'x',
            colors: ['#fff'],
            durationMs: 2000,
            brightness: 90,
        },
        ['A'],
        500,
    );
    assert.deepStrictEqual(
        br.frames.map((f) => [f.atMs, f.brightness]),
        [
            [500, 90],
            [1500, 20],
        ],
    );
    assert.strictEqual(br.endMs, 2500);
    // Pièce vide : rien, pas de crash.
    assert.strictEqual(
        expandEffect({ type: 'loading', target: 'x', colors: ['#fff'] }, [], 0)
            .frames.length,
        0,
    );
}

function run(): void {
    testTemplates();
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
