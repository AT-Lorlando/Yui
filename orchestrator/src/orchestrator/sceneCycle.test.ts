import assert from 'assert';
import { nextCycleIndex } from './sceneCycle';

const resetMs = 90 * 60_000;
const now = 1_000_000_000;

// Jamais lancé → première scène.
assert.strictEqual(
    nextCycleIndex({}, 'k', 3, now, { roomOff: false, resetMs }),
    0,
);
// Appui suivant, pièce allumée, récent → suivante, puis retour au début.
assert.strictEqual(
    nextCycleIndex({ k: { index: 0, at: now - 1000 } }, 'k', 3, now, {
        roomOff: false,
        resetMs,
    }),
    1,
);
assert.strictEqual(
    nextCycleIndex({ k: { index: 2, at: now - 1000 } }, 'k', 3, now, {
        roomOff: false,
        resetMs,
    }),
    0,
);
// Pièce éteinte → on repart de la première (aucune scène en cours).
assert.strictEqual(
    nextCycleIndex({ k: { index: 1, at: now - 1000 } }, 'k', 3, now, {
        roomOff: true,
        resetMs,
    }),
    0,
);
// Dernier appui trop ancien → première.
assert.strictEqual(
    nextCycleIndex({ k: { index: 1, at: now - resetMs - 1 } }, 'k', 3, now, {
        roomOff: false,
        resetMs,
    }),
    0,
);
// Liste vide → -1.
assert.strictEqual(
    nextCycleIndex({}, 'k', 0, now, { roomOff: false, resetMs }),
    -1,
);
// Une autre liste ne partage pas l'état.
assert.strictEqual(
    nextCycleIndex({ other: { index: 1, at: now } }, 'k', 3, now, {
        roomOff: false,
        resetMs,
    }),
    0,
);

console.log('All sceneCycle tests passed');
