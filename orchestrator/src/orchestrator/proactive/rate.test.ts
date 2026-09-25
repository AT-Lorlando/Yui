import assert from 'assert';
import { RateWindow } from './rate';

async function run(): Promise<void> {
    const w = new RateWindow(3600_000);
    const t0 = 1_000_000;
    assert.strictEqual(w.count('koya', t0), 0);
    assert.strictEqual(w.hit('koya', t0), 1);
    assert.strictEqual(w.hit('koya', t0 + 1000), 2);
    assert.strictEqual(w.hit('genkin', t0), 1, 'sources indépendantes');
    // Hors fenêtre : les anciens tombent.
    assert.strictEqual(w.count('koya', t0 + 3600_000 + 1001), 0);
    assert.strictEqual(w.hit('koya', t0 + 3600_000 + 1001), 1);
    // À la limite : encore dedans.
    assert.strictEqual(w.count('genkin', t0 + 3600_000), 1);

    console.log('All rate tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
