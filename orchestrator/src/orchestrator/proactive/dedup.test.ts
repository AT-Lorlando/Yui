import assert from 'assert';
import { Dedup } from './dedup';

function run(): void {
    const d = new Dedup();
    const cooldown = 30 * 60_000; // 30 min

    assert.strictEqual(d.isDuplicate('door', 0, cooldown), false);
    d.record('door', 0);
    assert.strictEqual(d.isDuplicate('door', 10 * 60_000, cooldown), true); // 10 min après
    assert.strictEqual(d.isDuplicate('door', 31 * 60_000, cooldown), false); // après cooldown
    assert.strictEqual(d.isDuplicate('other', 0, cooldown), false); // autre sujet

    console.log('All dedup tests passed');
}

run();
