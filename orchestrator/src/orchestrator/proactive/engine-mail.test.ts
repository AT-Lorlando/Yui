// Intégration moteur + concierge courrier : une correction qui sort un mail
// de « action » referme le sujet proactif qu'il avait ouvert (retenu + « dit »),
// via `closeMailSubject` — sinon Yui continuerait de rappeler un mail que
// Jérémy a déjà reclassé lui-même.
import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';
import type { Event } from './events';

// Même contrainte que engine-postits.test.ts : YUI_DATA_DIR posé AVANT que
// les modules ne résolvent leurs dataPath() au chargement.
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-em-'));
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');
const { SaidMemory } = require('./said') as typeof import('./said');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');
const { PostitRegistry } = require('./postits') as typeof import('./postits');

const tmpFile = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-em-')), name);

const NOW = new Date('2026-09-28T09:00:00').getTime();

function cfg(): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
        budgetPerDay: 3,
    };
}

async function run(): Promise<void> {
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
    const engine = new ProactiveEngine(cfg(), deps, {
        dedup: new Dedup(),
        journal: new ProactiveJournal(tmpFile('journal.json')),
        held,
        said,
        postits: new PostitRegistry(tmpFile('postits.json')),
    });

    // ── closeMailSubject : retire du retenu ET de la mémoire « dit » ─────
    const heldEvent: Event = {
        source: 'mail',
        key: 'mail-action-m9',
        kind: 'request',
        importance: 'utile',
        subject: 'Mail à traiter — X : « Sujet »',
        facts: ['détail'],
        at: NOW,
    };
    held.add(heldEvent, NOW);
    said.markSaid(
        [
            {
                subject: 'mail:mail-action-m9',
                fingerprint: 'fp',
                nature: 'request',
            },
        ],
        'brief',
        NOW,
    );
    assert.strictEqual(held.has('mail:mail-action-m9'), true);
    assert.strictEqual(said.isSaid('mail:mail-action-m9', 'fp', NOW), true);

    engine.closeMailSubject('m9');

    assert.strictEqual(held.has('mail:mail-action-m9'), false, 'retenu retiré');
    assert.strictEqual(
        said.isSaid('mail:mail-action-m9', 'fp', NOW),
        false,
        'mémoire "dit" refermée',
    );

    // ── Câblage réel : correct() vers une catégorie ≠ action referme le
    // sujet ; correct() vers "action" le laisse intact ────────────────────
    const held2: Event = { ...heldEvent, key: 'mail-action-m10' };
    held.add(held2, NOW);
    said.markSaid(
        [
            {
                subject: 'mail:mail-action-m10',
                fingerprint: 'fp',
                nature: 'request',
            },
        ],
        'brief',
        NOW,
    );
    engine.concierge.getState().proposals.push({
        mailId: 'm10',
        from: 'X <x@y.fr>',
        subject: 'Sujet',
        category: 'action',
        via: 'llm',
        stage: 'llm',
        proposeArchive: false,
    } as any);
    await engine.concierge.correct('m10', 'lire');
    assert.strictEqual(
        held.has('mail:mail-action-m10'),
        false,
        'correction vers "lire" referme le sujet',
    );

    const held3: Event = { ...heldEvent, key: 'mail-action-m11' };
    held.add(held3, NOW);
    engine.concierge.getState().proposals.push({
        mailId: 'm11',
        from: 'X <x@y.fr>',
        subject: 'Sujet',
        category: 'lire',
        via: 'llm',
        stage: 'llm',
        proposeArchive: false,
    } as any);
    await engine.concierge.correct('m11', 'action');
    assert.strictEqual(
        held.has('mail:mail-action-m11'),
        true,
        'correction vers "action" ne referme rien',
    );

    console.log('All engine-mail tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
