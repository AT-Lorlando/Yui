import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeldQueue } from './held';
import type { Event } from './events';

const NOW = new Date('2026-09-25T10:00:00').getTime();
const ev = (key: string, over: Partial<Event> = {}): Event => ({
    source: 'koya',
    key,
    kind: 'info',
    importance: 'info',
    subject: `s-${key}`,
    facts: [],
    at: NOW,
    ...over,
});

async function run(): Promise<void> {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'yui-held-')),
        'held.json',
    );
    const q = new HeldQueue(file, { max: 3, maxAgeMs: 48 * 3600_000 });

    q.add(ev('a'), NOW);
    q.add(ev('b'), NOW);
    q.add(ev('a', { facts: ['v2'] }), NOW + 1); // même clé → remplace, pas de doublon
    assert.strictEqual(q.size(), 2);
    assert.deepStrictEqual(q.peek(NOW + 1).find((e) => e.key === 'a')!.facts, [
        'v2',
    ]);

    // Borne : le plus ancien saute.
    q.add(ev('c'), NOW + 2);
    q.add(ev('d'), NOW + 3);
    assert.deepStrictEqual(
        q.peek(NOW + 3).map((e) => e.key),
        ['b', 'c', 'd'],
    );

    // Persistance.
    const q2 = new HeldQueue(file, { max: 3 });
    assert.strictEqual(q2.size(), 3);

    // Purge : ttl et âge.
    q2.add(ev('e', { ttlMs: 10 }), NOW + 3);
    assert.deepStrictEqual(
        q2.peek(NOW + 5).map((e) => e.key),
        ['c', 'd', 'e'],
        'e held until ttl',
    );
    assert.deepStrictEqual(
        q2.peek(NOW + 100).map((e) => e.key),
        ['c', 'd'],
        'ttl dépassé → purgé',
    );
    assert.deepStrictEqual(
        q2.peek(NOW + 49 * 3600_000),
        [],
        '48 h → tout purgé',
    );

    // take vide la file.
    const q3 = new HeldQueue();
    q3.add(ev('x'), NOW);
    assert.strictEqual(q3.take(NOW).length, 1);
    assert.strictEqual(q3.size(), 0);

    // Fichier édité/tronqué : les entrées qui ne sont pas des événements sont
    // écartées au chargement, `peek` ne lève pas.
    const dirty = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'yui-held-dirty-')),
        'held.json',
    );
    fs.writeFileSync(
        dirty,
        '[null, "x", {"source":"a","key":"k","kind":"info","importance":"info","subject":"s","facts":[],"at":1}]',
    );
    const q4 = new HeldQueue(dirty);
    assert.strictEqual(q4.size(), 1);
    assert.doesNotThrow(() => q4.peek(1));
    assert.deepStrictEqual(
        q4.peek(1).map((e) => e.key),
        ['k'],
    );

    console.log('All held tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
