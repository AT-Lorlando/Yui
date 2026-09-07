import assert from 'assert';
import { fadeSteps, hexToRgb } from './goveeFade';

function run(): void {
    assert.deepStrictEqual(hexToRgb('#ff0080'), { r: 255, g: 0, b: 128 });
    assert.deepStrictEqual(hexToRgb('00ff00'), { r: 0, g: 255, b: 0 });
    assert.throws(() => hexToRgb('rouge'));

    const from = { r: 0, g: 0, b: 0 };
    const to = { r: 255, g: 100, b: 50 };

    // La dernière étape est toujours exactement la cible.
    for (const dur of [100, 800, 1400, 60_000]) {
        const steps = fadeSteps(from, to, dur);
        assert.deepStrictEqual(steps[steps.length - 1], to, `durée ${dur}`);
    }

    // Durée courte → un seul envoi (pas de rampe inutile).
    assert.strictEqual(fadeSteps(from, to, 100).length, 1);

    // ~120 ms par étape sur une transition de tick d'animation.
    const s1400 = fadeSteps(from, to, 1_400);
    assert.ok(
        s1400.length >= 10 && s1400.length <= 14,
        `1400ms → ${s1400.length} étapes`,
    );

    // Longue durée → plafonnée (pas de spam UDP infini).
    assert.ok(fadeSteps(from, to, 60_000).length <= 30);

    // Interpolation monotone canal par canal.
    let prev = from;
    for (const c of s1400) {
        assert.ok(c.r >= prev.r && c.g >= prev.g && c.b >= prev.b);
        prev = c;
    }

    console.log('All goveeFade tests passed');
}

run();
