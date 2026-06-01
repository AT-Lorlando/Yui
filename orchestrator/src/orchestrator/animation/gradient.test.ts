import assert from 'assert';
import { sampleGradient, hexToRgb, rgbToHex } from './gradient';

function run(): void {
    // exact palette stops
    assert.strictEqual(sampleGradient(['#FF0000', '#00FF00'], 0), '#ff0000');
    // midpoint between red and green
    assert.strictEqual(sampleGradient(['#FF0000', '#00FF00'], 0.25), '#808000');
    // wraps: t=1 === t=0
    assert.strictEqual(
        sampleGradient(['#FF0000', '#00FF00'], 1),
        sampleGradient(['#FF0000', '#00FF00'], 0),
    );
    // round-trip helpers
    assert.deepStrictEqual(hexToRgb('#ff8000'), [255, 128, 0]);
    assert.strictEqual(rgbToHex(255, 128, 0), '#ff8000');

    console.log('All gradient tests passed');
}

run();
