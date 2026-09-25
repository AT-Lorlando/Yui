// Intégration moteur + juge : un candidat passe par le verdict LLM, la sortie
// respecte le canal choisi, et tout est tracé au journal (feedback possible).
import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { Event } from './events';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// La source 'genkin' n'est ni un connecteur ni un moment : sa première
// ingestion déclare la brique implicite `external:genkin` (declareExternal →
// saveConfig). YUI_DATA_DIR doit donc être posé AVANT que les modules ne
// résolvent leurs dataPath() au chargement — via require(), pas un import
// hissé (même contrainte que engine-action.test.ts).
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ej-'));
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');

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
    const engine = new ProactiveEngine(cfg(), deps, {
        dedup: new Dedup(tmpFile('dedup.json')),
        journal,
        held: new HeldQueue(),
    });

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

    // ── Verdict hold : retenu, rien d'émis, et la file survit jusqu'à ce qu'un
    // moment le livre vraiment ────────────────────────────────────────────────
    let verdict = '{"channel":"hold","message":"","reason":"pas urgent"}';
    const prompts: string[] = [];
    const holdNotified: string[] = [];
    const holdSpoken: string[] = [];
    const holdEngine = new ProactiveEngine(
        cfg(),
        {
            ...deps,
            complete: async (_s, u) => {
                prompts.push(u);
                return verdict;
            },
            notify: async (t) => void holdNotified.push(t),
            speak: async (t) => void holdSpoken.push(t),
        },
        {
            dedup: new Dedup(),
            journal: new ProactiveJournal(tmpFile('j2.json')),
            held: new HeldQueue(),
        },
    );
    const heldEvent: Event = {
        source: 'genkin',
        key: 'resto',
        kind: 'digest',
        importance: 'info',
        subject: 'Resto à 130 % du budget',
        facts: ['130 %'],
        at: deps.now!(),
    };
    await holdEngine.ingest(heldEvent);
    assert.deepStrictEqual(holdNotified, [], 'hold : rien d’émis');
    assert.ok(holdEngine.heldForMoment().includes('Resto à 130 % du budget'));
    assert.strictEqual(
        holdEngine.heldForMoment(),
        holdEngine.heldForMoment(),
        'heldForMoment ne consomme pas la file',
    );
    assert.strictEqual(holdEngine.heldCount(), 1, 'toujours retenu');

    // Moment livré (speak) → les retenus entrent dans ses faits, PUIS sont vidés.
    prompts.length = 0;
    verdict =
        '{"channel":"speak","message":"Point du matin.","reason":"il y a de la matière"}';
    await holdEngine.handleMoment('moment-wake', 'facts du réveil');
    const momentPrompt = prompts[prompts.length - 1] ?? '';
    assert.ok(
        momentPrompt.includes('Retenu depuis la dernière fois'),
        'le juge voit les retenus',
    );
    assert.ok(
        momentPrompt.includes('Resto à 130 % du budget'),
        'le sujet retenu est dans le prompt du moment',
    );
    assert.deepStrictEqual(holdNotified, ['Point du matin.']);
    assert.deepStrictEqual(holdSpoken, ['Point du matin.']);
    assert.strictEqual(holdEngine.heldCount(), 0, 'livré → file vidée');

    // Moment qui se tait (skip) → le retenu survit pour la prochaine fois.
    verdict = '{"channel":"hold","message":"","reason":"pas urgent"}';
    await holdEngine.ingest({
        ...heldEvent,
        key: 'courses',
        subject: 'Courses à 80 % du budget',
    });
    assert.strictEqual(holdEngine.heldCount(), 1);
    verdict = '{"channel":"skip","message":"","reason":"rien à dire"}';
    await holdEngine.handleMoment('moment-return', 'facts du retour');
    assert.strictEqual(
        holdEngine.heldCount(),
        1,
        'skip : les retenus ne sont pas détruits',
    );

    console.log('All engine-judge tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
