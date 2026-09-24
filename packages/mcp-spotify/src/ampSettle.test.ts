import assert from 'assert';
import { settleDelay } from './ampSettle';

// Jamais basculé → pas d'attente.
assert.strictEqual(settleDelay(0, 10_000, 5000), 0);
// Toggle il y a 1 s, fenêtre 5 s → encore 4 s à attendre.
assert.strictEqual(settleDelay(9_000, 10_000, 5000), 4000);
// Fenêtre écoulée → 0, jamais négatif.
assert.strictEqual(settleDelay(1_000, 10_000, 5000), 0);
// Pile à la limite.
assert.strictEqual(settleDelay(5_000, 10_000, 5000), 0);

console.log('All ampSettle tests passed');
