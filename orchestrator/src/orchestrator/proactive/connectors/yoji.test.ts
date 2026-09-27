import assert from 'assert';
import { yojiConnector, postitFacts, STALE_DAYS } from './yoji';
import { ConnectorState } from '../connectorState';
import type { ConnectorContext } from '../connector';

const NOW = new Date('2026-09-27T10:00:00').getTime();

const postit = (
    id: string,
    over: { title?: string; tags?: string[]; ageDays?: number } = {},
) => ({
    id,
    title: over.title ?? `Tâche ${id}`,
    state: 'todo',
    tags: over.tags ?? [],
    createdAt: '2026-09-20T10:00:00Z',
    ageDays: over.ageDays ?? 1,
});

function ctx(callTool: ConnectorContext['callTool']): ConnectorContext {
    return {
        callTool,
        settings: {},
        state: new ConnectorState(),
        presence: () => 'home',
        now: () => NOW,
        log: { info: () => {}, warn: () => {} },
    };
}

async function run(): Promise<void> {
    assert.strictEqual(yojiConnector.id, 'yoji');
    assert.strictEqual(yojiConnector.name, 'Post-its Yoji');
    assert.strictEqual(yojiConnector.defaultEnabled, true);
    assert.strictEqual(yojiConnector.pollMinutes, undefined, 'jamais pollé');
    assert.strictEqual(yojiConnector.events, undefined);

    // Mise en forme pure : tag `yui` d'abord, ancien = label dédié, clé = id.
    const facts = postitFacts([
        postit('a', { title: 'Renvoyer le RIB', ageDays: 2 }),
        postit('b', { title: 'Vieux truc', ageDays: STALE_DAYS + 1 }),
        postit('c', { title: 'Répondre : Kinéis', tags: ['yui'], ageDays: 0 }),
        postit('d', { title: 'Pile 7 jours', ageDays: STALE_DAYS }),
    ]);
    assert.deepStrictEqual(facts, [
        { label: 'Post-it', value: 'Répondre : Kinéis (0 j)', key: 'c' },
        { label: 'Post-it', value: 'Renvoyer le RIB (2 j)', key: 'a' },
        { label: 'Post-it ancien', value: 'Vieux truc (8 j)', key: 'b' },
        { label: 'Post-it', value: 'Pile 7 jours (7 j)', key: 'd' },
    ]);

    // Plafond global à 8, anciens compris — et l'ordre `yui` d'abord est stable.
    const many = Array.from({ length: 12 }, (_, i) =>
        postit(`p${i}`, {
            tags: i >= 10 ? ['yui'] : [],
            ageDays: i % 2 ? 10 : 1,
        }),
    );
    const capped = postitFacts(many);
    assert.strictEqual(capped.length, 8);
    assert.deepStrictEqual(
        capped.slice(0, 2).map((f) => f.key),
        ['p10', 'p11'],
    );
    assert.deepStrictEqual(
        capped.slice(2).map((f) => f.key),
        ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'],
    );
    assert.ok(capped.some((f) => f.label === 'Post-it ancien'));

    // Entrées mal formées ignorées ; titre vide ignoré.
    assert.deepStrictEqual(
        postitFacts([null, 'x', { id: 'z' }, postit('ok', { title: 'OK' })]),
        [{ label: 'Post-it', value: 'OK (1 j)', key: 'ok' }],
    );

    // snapshot : appelle list_postits, accepte un JSON texte.
    const calls: string[] = [];
    const snap = await yojiConnector.snapshot!(
        ctx(async (t) => {
            calls.push(t);
            return [postit('a', { title: 'A', ageDays: 3 })];
        }),
    );
    assert.deepStrictEqual(calls, ['list_postits']);
    assert.deepStrictEqual(snap, [
        { label: 'Post-it', value: 'A (3 j)', key: 'a' },
    ]);
    assert.deepStrictEqual(
        await yojiConnector.snapshot!(
            ctx(async () => JSON.stringify([postit('t', { title: 'T' })])),
        ),
        [{ label: 'Post-it', value: 'T (1 j)', key: 't' }],
    );
    assert.deepStrictEqual(
        await yojiConnector.snapshot!(ctx(async () => [])),
        [],
    );

    // Outil en échec ou réponse qui n'est pas une liste → le connecteur lève
    // (c'est le runner qui compte les échecs).
    await assert.rejects(
        yojiConnector.snapshot!(
            ctx(async () => {
                throw new Error('yoji injoignable');
            }),
        ),
        /injoignable/,
    );
    await assert.rejects(
        yojiConnector.snapshot!(ctx(async () => null)),
        /liste/,
    );

    console.log('All yoji connector tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
