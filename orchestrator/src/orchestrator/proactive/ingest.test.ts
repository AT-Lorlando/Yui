import assert from 'assert';
import { Ingest } from './ingest';
import { Dedup } from './dedup';
import { HeldQueue } from './held';
import { RateWindow } from './rate';
import { eventKey, factsFingerprint } from './events';
import type { Event } from './events';

const NOW = new Date('2026-09-25T14:00:00').getTime(); // hors heures de silence
const ev = (key: string, over: Partial<Event> = {}): Event => ({
    source: 'koya',
    key,
    kind: 'alert',
    importance: 'utile',
    subject: `s-${key}`,
    facts: ['f'],
    at: NOW,
    ...over,
});

async function run(): Promise<void> {
    let now = NOW;
    const judged: string[] = [];
    const held = new HeldQueue();
    // Ingest lui-même ne dédup jamais un accepté (c'est le rôle du
    // consommateur — `applyVerdict` du moteur, Task 7 — cf. la Note du
    // brief). Le juge factice simule donc ici ce consommateur pour que le
    // scénario « accepté puis dédup dans le cooldown » soit observable en
    // isolation.
    const mk = (quiet = { start: '23:00', end: '07:00' }) => {
        const dedup = new Dedup();
        return new Ingest({
            dedup,
            held,
            rate: new RateWindow(),
            now: () => now,
            defaultCooldownMs: () => 30 * 60_000,
            maxPerHour: (s) => (s === 'koya' ? 2 : 6),
            quietHours: () => quiet,
            judge: async (e) => {
                judged.push(e.key);
                dedup.record(eventKey(e), now, undefined, factsFingerprint(e));
            },
        });
    };

    // 1. Périmé → jamais jugé.
    const ing = mk();
    assert.strictEqual(
        await ing.ingest(ev('old', { at: NOW - 10_000, ttlMs: 5000 })),
        'expired',
    );
    assert.deepStrictEqual(judged, []);

    // 2. Accepté puis dédup dans le cooldown ; facts changés → repasse.
    assert.strictEqual(await ing.ingest(ev('disk')), 'accepted');
    assert.strictEqual(await ing.ingest(ev('disk')), 'deduplicated');
    assert.strictEqual(
        await ing.ingest(ev('disk', { facts: ['94 %'] })),
        'accepted',
        'facts différents',
    );
    assert.deepStrictEqual(judged, ['disk', 'disk']);

    // 3. Cooldown par source : koya limité à 2/h → le 3e est retenu SANS juge.
    assert.strictEqual(await ing.ingest(ev('pm2')), 'held');
    assert.strictEqual(held.size(), 1);
    assert.deepStrictEqual(
        judged,
        ['disk', 'disk'],
        'aucun appel juge pour un retenu',
    );
    // Une autre source n'est pas pénalisée.
    assert.strictEqual(
        await ing.ingest(ev('x', { source: 'genkin' })),
        'accepted',
    );
    // L'urgent passe malgré le cooldown de source.
    assert.strictEqual(
        await ing.ingest(ev('fire', { importance: 'urgent' })),
        'accepted',
    );
    // Une heure plus tard, koya repasse.
    now = NOW + 3600_001;
    assert.strictEqual(await ing.ingest(ev('later')), 'accepted');

    // 4. Heures de silence → retenu (sauf urgent) ; critique ignore tout.
    now = new Date('2026-09-25T23:30:00').getTime();
    const quietIng = mk();
    assert.strictEqual(await quietIng.ingest(ev('night')), 'held');
    assert.strictEqual(
        await quietIng.ingest(ev('night-urgent', { importance: 'urgent' })),
        'accepted',
    );
    assert.strictEqual(
        await quietIng.ingest(ev('night-critique', { importance: 'critique' })),
        'accepted',
    );
    assert.strictEqual(
        await quietIng.ingest(ev('night-critique', { importance: 'critique' })),
        'accepted',
        'critique : pas de dédup',
    );

    // 5. Le juge qui lève ne casse pas l'ingestion.
    const boom = new Ingest({
        dedup: new Dedup(),
        held: new HeldQueue(),
        rate: new RateWindow(),
        now: () => NOW,
        defaultCooldownMs: () => 1000,
        maxPerHour: () => 6,
        quietHours: () => ({ start: '23:00', end: '07:00' }),
        judge: async () => {
            throw new Error('llm down');
        },
    });
    assert.strictEqual(await boom.ingest(ev('k')), 'accepted');

    // 6. ingestAll compte.
    now = NOW; // hors heures de silence (le bloc 4 a laissé `now` à 23:30)
    const counts = await mk().ingestAll([
        ev('a'),
        ev('a'),
        ev('b', { at: NOW - 10, ttlMs: 1 }),
    ]);
    assert.deepStrictEqual(counts, {
        accepted: 1,
        deduplicated: 1,
        expired: 1,
        held: 0,
    });

    console.log('All ingest tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
