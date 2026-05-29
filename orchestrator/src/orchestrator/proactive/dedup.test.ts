import assert from 'assert';
import * as fs from 'fs';
import { Dedup } from './dedup';

function run(): void {
    const d = new Dedup();
    const cooldown = 30 * 60_000; // 30 min

    assert.strictEqual(d.isDuplicate('door', 0, cooldown), false);
    d.record('door', 0);
    assert.strictEqual(d.isDuplicate('door', 10 * 60_000, cooldown), true); // 10 min après
    assert.strictEqual(d.isDuplicate('door', 31 * 60_000, cooldown), false); // après cooldown
    assert.strictEqual(d.isDuplicate('other', 0, cooldown), false); // autre sujet

    // persistance : un nouveau Dedup relit l'état depuis le fichier
    const file = 'data/proactive-dedup.test.json';
    fs.rmSync(file, { force: true });
    try {
        const a = new Dedup(file);
        a.record('door', 1000);
        const b = new Dedup(file);
        assert.strictEqual(
            b.isDuplicate('door', 1000 + 10 * 60_000, cooldown),
            true,
        );
        assert.strictEqual(
            b.isDuplicate('door', 1000 + 31 * 60_000, cooldown),
            false,
        );
    } finally {
        fs.rmSync(file, { force: true });
    }

    console.log('All dedup tests passed');
}

run();
