// Réserve et mémoire exposées par le moteur (page Secrétaire).
import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// YUI_DATA_DIR posé AVANT que les modules ne résolvent leurs dataPath().
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-es-'));
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');
const { SaidMemory } = require('./said') as typeof import('./said');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');
const { PostitRegistry } = require('./postits') as typeof import('./postits');

const tmpFile = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-es-')), name);
const NOW = new Date('2026-10-06T09:00:00').getTime();

async function run(): Promise<void> {
    const cfg: ProactiveConfig = {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
        budgetPerDay: 3,
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
    const held = new HeldQueue();
    const said = new SaidMemory();
    const journal = new ProactiveJournal(tmpFile('journal.json'));
    const engine = new ProactiveEngine(cfg, deps, {
        dedup: new Dedup(),
        journal,
        held,
        said,
        postits: new PostitRegistry(tmpFile('postits.json')),
    });

    held.add(
        {
            source: 'mail',
            key: 'k1',
            kind: 'x',
            importance: 'utile',
            subject: 'Sujet',
            facts: ['f'],
            at: NOW,
        } as any,
        NOW,
    );
    assert.strictEqual(engine.heldList().length, 1);
    assert.strictEqual(engine.heldRemove('mail:inconnu'), false);
    assert.strictEqual(engine.heldRemove('mail:k1'), true);
    assert.strictEqual(engine.heldList().length, 0);

    said.markSaid(
        [{ subject: 'a:1', fingerprint: 'f', nature: 'info' }],
        'speak',
        NOW,
    );
    said.markSaid(
        [{ subject: 'b:2', fingerprint: 'f', nature: 'alert' }],
        'speak',
        NOW + 1,
    );
    assert.strictEqual(engine.saidList().length, 2);
    assert.strictEqual(engine.saidForget('zzz'), false, '404 sémantique');
    assert.strictEqual(engine.saidForget('a:1'), true);
    assert.strictEqual(engine.saidForgetAll(), 1);
    assert.strictEqual(engine.saidList().length, 0);

    for (const at of [1, 2, 3])
        journal.record({
            at,
            source: 's',
            subject: 'x',
            channel: 'skip',
            message: '',
        });
    assert.deepStrictEqual(
        engine.getJournal(50, 3).map((e) => e.at),
        [2, 1],
    );
    console.log('All engine-secretaire tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
