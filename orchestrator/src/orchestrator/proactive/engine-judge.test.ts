// Intégration moteur + juge : un candidat passe par le verdict LLM, la sortie
// respecte le canal choisi, et tout est tracé au journal (feedback possible).
import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ProactiveEngine } from './index';
import { DigestBuffer } from './digest';
import { Dedup } from './dedup';
import { ProactiveJournal } from './journal';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

const tmpFile = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ej-')), name);

function cfg(): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        digestTime: '07:00',
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
        budgetPerDay: 3,
    };
}

async function run(): Promise<void> {
    const notified: string[] = [];
    const spoken: string[] = [];
    let judgeCalls = 0;
    const deps: ProactiveDeps = {
        complete: async (sys) => {
            judgeCalls++;
            assert.ok(
                sys.includes('juge d’attention') ||
                    sys.includes("juge d'attention"),
            );
            return '{"channel":"notify","message":"Ton colis ASOS arrive demain.","reason":"utile, pas urgent"}';
        },
        notify: async (t) => void notified.push(t),
        speak: async (t) => void spoken.push(t),
        presenceState: () => 'home' as PresenceState,
        subscribePresence: () => {},
        deviceHandler: async () => null,
        runScene: async () => ({ success: true }),
        now: () => new Date('2026-09-16T14:00:00').getTime(),
    };
    const journal = new ProactiveJournal(tmpFile('journal.json'));
    const engine = new ProactiveEngine(
        cfg(),
        deps,
        new DigestBuffer(),
        new Dedup(tmpFile('dedup.json')),
        journal,
    );

    await engine.processCandidate({
        watcherId: 'deliveries',
        subject: 'parcel-asos',
        importance: 'utile',
        facts: 'Colis ASOS estimé demain',
    });

    assert.strictEqual(judgeCalls, 1);
    assert.deepStrictEqual(notified, ['Ton colis ASOS arrive demain.']);
    assert.deepStrictEqual(spoken, [], 'notify → pas de TTS');

    const entries = engine.getJournal();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]!.channel, 'notify');
    assert.strictEqual(entries[0]!.source, 'deliveries');
    assert.ok(engine.setFeedback(entries[0]!.id, 'down'));
    assert.strictEqual(engine.getJournal()[0]!.feedback, 'down');

    // Même sujet aussitôt → dédup avant le juge (pas de 2e appel LLM).
    await engine.processCandidate({
        watcherId: 'deliveries',
        subject: 'parcel-asos',
        importance: 'utile',
        facts: 'Colis ASOS estimé demain',
    });
    assert.strictEqual(judgeCalls, 1, 'dédup avant juge');
    assert.strictEqual(notified.length, 1);

    // Briques listées avec état effectif.
    const bricks = engine.getBricks();
    assert.ok(bricks.some((b) => b.id === 'judge' && b.enabled));
    assert.ok(bricks.some((b) => b.id === 'irrigation-rain' && !b.enabled));

    console.log('All engine-judge tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
