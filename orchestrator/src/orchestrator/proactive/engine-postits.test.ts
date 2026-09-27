// Intégration moteur + post-its : une intention `todo` acceptée ou retenue
// crée un post-it Yoji (une fois par origine, quota quotidien), l'événement
// retenu porte la ligne qui le dit, `ingestAll` applique le même crochet, et
// le tick de situation referme le sujet d'un post-it disparu de Yoji.
import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { Event } from './events';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// Même contrainte que engine-action.test.ts : YUI_DATA_DIR posé AVANT que
// les modules ne résolvent leurs dataPath() au chargement.
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ep-'));
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');
const { SaidMemory } = require('./said') as typeof import('./said');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');
const { PostitRegistry } = require('./postits') as typeof import('./postits');

const tmpFile = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ep-')), name);

const NOW = new Date('2026-09-27T14:00:00').getTime();
const POSTIT_LINE = /^Je t'ai mis un post-it : « .+ »$/;

function cfg(): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
        budgetPerDay: 3,
        postitsPerDay: 2,
    };
}

const ev = (key: string, over: Partial<Event> = {}): Event => ({
    source: 'koya',
    key,
    kind: 'request',
    importance: 'utile',
    subject: `Sujet ${key}`,
    facts: ['détail'],
    at: NOW,
    todo: { title: `Faire ${key}` },
    ...over,
});

async function run(): Promise<void> {
    let nowMs = NOW;
    const created: Array<Record<string, unknown> | undefined> = [];
    let postitsInYoji: Array<{ id: string }> | (() => unknown) = [];
    const deps: ProactiveDeps = {
        complete: async () => '{"channel":"skip","reason":"test"}',
        notify: async () => {},
        speak: async () => {},
        presenceState: () => 'home' as PresenceState,
        subscribePresence: () => () => {},
        deviceHandler: async (tool, args) => {
            if (tool === 'create_postit') {
                created.push(args);
                return { id: `p${created.length}`, title: args?.title };
            }
            if (tool === 'list_postits') {
                return typeof postitsInYoji === 'function'
                    ? postitsInYoji()
                    : postitsInYoji;
            }
            return null;
        },
        runScene: async () => ({ success: true }),
        now: () => nowMs,
    };
    const held = new HeldQueue();
    const said = new SaidMemory();
    const registry = new PostitRegistry(tmpFile('postits.json'));
    const engine = new ProactiveEngine(cfg(), deps, {
        dedup: new Dedup(),
        journal: new ProactiveJournal(tmpFile('journal.json')),
        held,
        said,
        postits: registry,
    });

    // ── Retenu par le juge (utile) : post-it créé, ligne portée par le retenu ──
    assert.strictEqual(await engine.ingest(ev('a')), 'accepted');
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(created[0], {
        title: 'Faire a',
        tags: ['yui', 'koya'],
    });
    assert.strictEqual(held.has('koya:a'), true);
    const heldA = held.peek(nowMs).find((e) => e.key === 'a')!;
    assert.strictEqual(heldA.facts.length, 2);
    assert.ok(POSTIT_LINE.test(heldA.facts[1]!), heldA.facts[1]);
    assert.ok(heldA.facts[1]!.includes('« Faire a »'));
    assert.deepStrictEqual(registry.open(), [
        { origin: 'koya:a', postitId: 'p1' },
    ]);

    // Même événement aussitôt → dédup : pas de second post-it.
    assert.strictEqual(await engine.ingest(ev('a')), 'deduplicated');
    assert.strictEqual(created.length, 1);

    // Sans intention : rien de créé.
    assert.strictEqual(
        await engine.ingest(ev('plain', { todo: undefined })),
        'accepted',
    );
    assert.strictEqual(created.length, 1);

    // ── Retenu par la porte (heures de silence) : même crochet ──────────
    nowMs = new Date('2026-09-27T23:30:00').getTime();
    assert.strictEqual(await engine.ingest(ev('b')), 'held');
    assert.strictEqual(created.length, 2);
    const heldB = held.peek(nowMs).find((e) => e.key === 'b')!;
    assert.ok(
        POSTIT_LINE.test(heldB.facts[1]!),
        'retenu par la porte : ligne portée',
    );
    nowMs = NOW;

    // ── Quota du jour (2) atteint : refus silencieux, retenu intact ──────
    assert.strictEqual(await engine.ingest(ev('c')), 'accepted');
    assert.strictEqual(created.length, 2, 'quota → pas d’appel');
    assert.deepStrictEqual(held.peek(nowMs).find((e) => e.key === 'c')!.facts, [
        'détail',
    ]);
    assert.strictEqual(registry.has('koya:c'), false);

    // Urgent jugé (accepted, pas retenu) : post-it créé le lendemain, mais
    // rien à réécrire dans la file.
    nowMs = NOW + 24 * 3600_000;
    assert.strictEqual(
        await engine.ingest(ev('d', { importance: 'urgent', kind: 'alert' })),
        'accepted',
    );
    assert.strictEqual(created.length, 3);
    assert.strictEqual(held.has('koya:d'), false);
    assert.strictEqual(registry.has('koya:d'), true);

    // ── ingestAll : compte inchangé, crochet appliqué à chaque élément ──
    const counts = await engine.ingestAll([
        ev('e'),
        ev('e'),
        ev('f', { todo: undefined }),
    ]);
    assert.deepStrictEqual(counts, {
        accepted: 2,
        deduplicated: 1,
        expired: 0,
        held: 0,
        ignored: 0,
    });
    assert.strictEqual(created.length, 4, 'e créé, f sans intention');
    assert.ok(
        POSTIT_LINE.test(
            held.peek(nowMs).find((e) => e.key === 'e')!.facts[1]!,
        ),
    );

    // ── Clôture au tick : post-it disparu de Yoji → sujet refermé ──────
    said.markSaid(
        [
            { subject: 'koya:a', fingerprint: 'fp', nature: 'request' },
            { subject: 'koya:b', fingerprint: 'fp', nature: 'request' },
        ],
        'brief',
        nowMs,
    );
    // Yoji injoignable : rien n'est conclu.
    postitsInYoji = () => {
        throw new Error('yoji injoignable');
    };
    await engine.situationTick();
    assert.strictEqual(said.isSaid('koya:a', 'fp', nowMs), true);
    assert.strictEqual(registry.open().length, 4);
    // Réponse qui n'est pas une liste : idem.
    postitsInYoji = () => null;
    await engine.situationTick();
    assert.strictEqual(registry.open().length, 4);
    // p1 (a) fait, p2 (b) toujours là.
    postitsInYoji = [{ id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
    await engine.situationTick();
    assert.strictEqual(said.isSaid('koya:a', 'fp', nowMs), false, 'a refermé');
    assert.strictEqual(said.isSaid('koya:b', 'fp', nowMs), true, 'b intact');
    assert.deepStrictEqual(
        registry.open().map((o) => o.origin),
        ['koya:b', 'koya:d', 'koya:e'],
    );
    assert.strictEqual(registry.has('koya:a'), true, 'clos mais jamais recréé');
    // Rien d'ouvert → list_postits n'est plus appelé.
    let listCalls = 0;
    postitsInYoji = () => {
        listCalls++;
        return [];
    };
    await engine.situationTick();
    assert.strictEqual(listCalls, 1);
    assert.strictEqual(registry.open().length, 0);
    await engine.situationTick();
    assert.strictEqual(listCalls, 1, 'plus rien d’ouvert → pas d’appel');

    console.log('All engine-postits tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
