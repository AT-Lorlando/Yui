// Vue des connecteurs exposée par le moteur (page Secrétaire) : actif,
// désactivé, source externe.
import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// YUI_DATA_DIR posé AVANT que les modules ne résolvent leurs dataPath().
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ec-'));
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');
const { SaidMemory } = require('./said') as typeof import('./said');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');
const { PostitRegistry } = require('./postits') as typeof import('./postits');
const { ConnectorNotFound } = require('./runner') as typeof import('./runner');

const tmpFile = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ec-')), name);
const NOW = new Date('2026-10-15T09:00:00').getTime();

async function run(): Promise<void> {
    const cfg: ProactiveConfig = {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
        budgetPerDay: 3,
        bricks: {
            weather: { enabled: false, settings: {} },
            judge: { enabled: true, settings: {} },
        },
    };
    const deps: ProactiveDeps = {
        complete: async () => '{"channel":"skip","reason":"test"}',
        notify: async () => {},
        speak: async () => {},
        presenceState: () => 'home' as PresenceState,
        subscribePresence: () => () => {},
        deviceHandler: async () => null,
        runScene: async () => ({ success: true }),
        now: () => NOW,
    };
    const engine = new ProactiveEngine(cfg, deps, {
        dedup: new Dedup(),
        journal: new ProactiveJournal(tmpFile('journal.json')),
        held: new HeldQueue(),
        said: new SaidMemory(),
        postits: new PostitRegistry(tmpFile('postits.json')),
    });

    // Moteur arrêté : relève manuelle refusée, tout est à l'arrêt.
    await assert.rejects(engine.pollConnector('yoji'), ConnectorNotFound);
    assert.ok(engine.connectorsView().every((c) => !c.enabled));

    // Runner construit sans start() (pas de timers ni de polls réels).
    (engine as any).runner = (engine as any).buildRunner();

    await engine.ingest({
        source: 'koya',
        key: 'deploy-1',
        kind: 'info',
        importance: 'info',
        subject: 'Déploiement Koya',
        facts: ['ok'],
        at: NOW,
    });

    const view = engine.connectorsView();
    const weather = view.find((c) => c.id === 'weather')!;
    assert.strictEqual(weather.enabled, false, 'brique OFF');
    assert.strictEqual(weather.polling, false);
    assert.strictEqual(weather.failures, 0);
    assert.deepStrictEqual(weather.recent, []);
    assert.strictEqual(weather.mode, 'poll');
    assert.ok(weather.pollMinutes);

    const yoji = view.find((c) => c.id === 'yoji')!;
    assert.strictEqual(yoji.enabled, true, 'connecteur actif');
    assert.strictEqual(yoji.failures, 0);

    const koya = view.find((c) => c.id === 'external:koya')!;
    assert.ok(koya, 'source externe listée');
    assert.strictEqual(koya.name, 'koya');
    assert.strictEqual(koya.mode, 'subscribe');
    assert.strictEqual(koya.enabled, true);
    assert.strictEqual(koya.lastOkAt, NOW);
    assert.deepStrictEqual(
        koya.recent.map((r) => [r.key, r.subject]),
        [['deploy-1', 'Déploiement Koya']],
    );
    assert.ok(koya.recent[0].outcome);
    // Ordre : connecteurs déclarés d'abord, sources externes en fin.
    assert.strictEqual(view[view.length - 1].id, 'external:koya');
    // Un connecteur déclaré ne devient jamais une source externe.
    assert.ok(!view.some((c) => c.id === 'external:yoji'));

    await assert.rejects(engine.pollConnector('nope'), ConnectorNotFound);
    console.log('All engine-connectors tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
