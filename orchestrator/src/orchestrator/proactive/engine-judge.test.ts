// Intégration moteur + juge + composeur : un non-urgent est retenu SANS LLM,
// un urgent passe par le verdict du juge, un moment compose un point à partir
// des retenus, et un 👎 sur ce point prolonge la mémoire « dit » de ses sujets.
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
const { SaidMemory } = require('./said') as typeof import('./said');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');
const { factsFingerprint } = require('./events') as typeof import('./events');

const tmpFile = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ej-')), name);

const DAY_MS = 24 * 3600_000;
const NOW = new Date('2026-09-16T14:00:00').getTime();

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

const isJudgePrompt = (sys: string) =>
    sys.includes('juge d’attention') || sys.includes("juge d'attention");
const isBriefPrompt = (sys: string) => sys.includes('secrétaire');

async function run(): Promise<void> {
    // ── Événements : non-urgent retenu sans LLM, urgent jugé ──────────────
    const notified: string[] = [];
    const spoken: string[] = [];
    let judgeCalls = 0;
    const deps: ProactiveDeps = {
        complete: async (sys) => {
            assert.ok(isJudgePrompt(sys), 'seul le juge est consulté ici');
            judgeCalls++;
            return '{"channel":"notify","message":"Ton colis ASOS est perdu.","reason":"urgent mais pas de quoi parler"}';
        },
        notify: async (t) => void notified.push(t),
        speak: async (t) => void spoken.push(t),
        presenceState: () => 'home' as PresenceState,
        subscribePresence: () => () => {},
        deviceHandler: async () => null,
        runScene: async () => ({ success: true }),
        now: () => NOW,
    };
    const journal = new ProactiveJournal(tmpFile('journal.json'));
    const engine = new ProactiveEngine(cfg(), deps, {
        dedup: new Dedup(tmpFile('dedup.json')),
        journal,
        held: new HeldQueue(),
        said: new SaidMemory(),
    });

    await engine.processCandidate({
        watcherId: 'deliveries',
        subject: 'parcel-asos',
        importance: 'utile',
        facts: 'Colis ASOS estimé demain',
    });
    assert.strictEqual(judgeCalls, 0, 'utile → aucun appel LLM');
    assert.deepStrictEqual(notified, [], 'utile → rien d’émis');
    assert.strictEqual(engine.heldCount(), 1, 'utile → retenu');
    assert.strictEqual(
        engine.getJournal().length,
        0,
        'retenu : pas au journal',
    );

    await engine.processCandidate({
        watcherId: 'deliveries',
        subject: 'parcel-lost',
        importance: 'urgent',
        facts: 'Colis ASOS perdu par le transporteur',
    });
    assert.strictEqual(judgeCalls, 1, 'urgent → juge une fois');
    assert.deepStrictEqual(notified, ['Ton colis ASOS est perdu.']);
    assert.deepStrictEqual(spoken, [], 'notify → pas de TTS');
    assert.strictEqual(engine.heldCount(), 1, 'l’urgent n’est pas retenu');

    const entries = engine.getJournal();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]!.channel, 'notify');
    assert.strictEqual(entries[0]!.source, 'deliveries');
    assert.ok(engine.setFeedback(entries[0]!.id, 'down'));
    assert.strictEqual(engine.getJournal()[0]!.feedback, 'down');

    // Même sujet aussitôt → dédup avant le juge (pas de 2e appel LLM).
    await engine.processCandidate({
        watcherId: 'deliveries',
        subject: 'parcel-lost',
        importance: 'urgent',
        facts: 'Colis ASOS perdu par le transporteur',
    });
    assert.strictEqual(judgeCalls, 1, 'dédup avant juge');
    assert.strictEqual(notified.length, 1);

    // Briques listées avec état effectif.
    const bricks = engine.getBricks();
    assert.ok(bricks.some((b) => b.id === 'judge' && b.enabled));
    assert.ok(bricks.some((b) => b.id === 'irrigation-rain' && !b.enabled));

    // ── Moments : le composeur, pas le juge ───────────────────────────────
    const systems: string[] = [];
    const momentNotified: string[] = [];
    const momentSpoken: string[] = [];
    const said = new SaidMemory();
    const momentEngine = new ProactiveEngine(
        cfg(),
        {
            ...deps,
            complete: async (sys) => {
                systems.push(sys);
                return 'Pendant ton absence, le resto est passé à 130 % du budget.';
            },
            notify: async (t) => void momentNotified.push(t),
            speak: async (t) => void momentSpoken.push(t),
        },
        {
            dedup: new Dedup(),
            journal: new ProactiveJournal(tmpFile('j2.json')),
            held: new HeldQueue(),
            said,
        },
    );
    const heldEvent: Event = {
        source: 'genkin',
        key: 'resto',
        kind: 'digest',
        importance: 'info',
        subject: 'Resto à 130 % du budget',
        facts: ['130 %'],
        at: NOW,
    };
    await momentEngine.ingest(heldEvent);
    assert.strictEqual(systems.length, 0, 'info : retenu sans LLM');
    assert.strictEqual(momentNotified.length, 0);
    assert.strictEqual(momentEngine.heldCount(), 1);

    // Retour avec un retenu → UN appel LLM (le composeur), speak + notify,
    // retenu retiré, journal `moment` avec ses sujets.
    await momentEngine.handleMoment('moment-return', 'facts du retour');
    assert.strictEqual(systems.length, 1, 'un seul appel : le composeur');
    assert.ok(isBriefPrompt(systems[0]!), 'c’est le prompt du composeur');
    assert.ok(!isJudgePrompt(systems[0]!), 'le juge ne voit plus les moments');
    assert.deepStrictEqual(momentNotified, [
        'Pendant ton absence, le resto est passé à 130 % du budget.',
    ]);
    assert.deepStrictEqual(momentSpoken, momentNotified, 'présent → TTS');
    assert.strictEqual(momentEngine.heldCount(), 0, 'dit → retiré');
    const momentEntry = momentEngine.getJournal()[0]!;
    assert.strictEqual(momentEntry.kind, 'moment');
    assert.strictEqual(momentEntry.channel, 'speak');
    assert.strictEqual(momentEntry.source, 'moment-return');
    assert.deepStrictEqual(momentEntry.subjects, ['genkin:resto']);

    // Même moment dans les 2 h → garde de dédup : ni LLM ni sortie, le
    // nouveau retenu attend.
    await momentEngine.ingest({
        ...heldEvent,
        key: 'courses',
        subject: 'Courses à 80 % du budget',
        facts: ['80 %'],
    });
    assert.strictEqual(momentEngine.heldCount(), 1);
    await momentEngine.handleMoment('moment-return', 'facts du retour');
    assert.strictEqual(systems.length, 1, 'moment dédupliqué 2 h');
    assert.strictEqual(momentNotified.length, 1);
    assert.strictEqual(momentEngine.heldCount(), 1, 'le retenu survit');

    // Moment sans matière → silence total, aucun appel LLM, rien au journal.
    const journalBefore = momentEngine.getJournal().length;
    const silentEngine = new ProactiveEngine(
        cfg(),
        {
            ...deps,
            complete: async (sys) => {
                systems.push(sys);
                return 'Bonjour.';
            },
            notify: async (t) => void momentNotified.push(t),
            speak: async (t) => void momentSpoken.push(t),
        },
        {
            dedup: new Dedup(),
            journal: new ProactiveJournal(tmpFile('j3.json')),
            held: new HeldQueue(),
            said: new SaidMemory(),
        },
    );
    await silentEngine.handleMoment('moment-wake', 'facts du réveil');
    assert.strictEqual(systems.length, 1, 'sans matière : pas de LLM');
    assert.strictEqual(momentNotified.length, 1, 'sans matière : rien d’émis');
    assert.strictEqual(silentEngine.getJournal().length, 0);
    assert.strictEqual(momentEngine.getJournal().length, journalBefore);

    // 👎 sur le point → ses sujets restent « dits » 30 jours (au lieu de 7).
    const fp = factsFingerprint(heldEvent);
    assert.strictEqual(
        said.isSaid('genkin:resto', fp, NOW + 29 * DAY_MS),
        false,
        'digest : dit 7 jours seulement avant le 👎',
    );
    assert.ok(momentEngine.setFeedback(momentEntry.id, 'down'));
    assert.strictEqual(
        said.isSaid('genkin:resto', fp, NOW + 29 * DAY_MS),
        true,
        '👎 → dit pendant 30 jours',
    );

    // ── Point à la demande : aperçu sans effet, puis point journalisé ─────
    const preview = momentEngine.briefPreview();
    assert.strictEqual(preview.length, 1);
    assert.strictEqual(preview[0]!.subject, 'genkin:courses');
    assert.strictEqual(momentEngine.heldCount(), 1, 'l’aperçu ne retire rien');
    const before = { llm: systems.length, out: momentNotified.length };
    const result = await momentEngine.brief('since-last');
    assert.strictEqual(systems.length, before.llm + 1, 'un appel composeur');
    assert.ok(result.text.length > 0);
    assert.strictEqual(result.channel, 'brief');
    assert.deepStrictEqual(result.subjects, ['genkin:courses']);
    assert.strictEqual(momentNotified.length, before.out, 'ni push ni TTS');
    assert.strictEqual(momentEngine.heldCount(), 0, 'dit → retiré');
    assert.strictEqual(momentEngine.getJournal()[0]!.kind, 'brief');

    // ── Sérialisation des moments : le tick d'intervalle et la transition de
    // présence peuvent appeler handleMoment en concurrence — le second appel
    // ne doit démarrer sa propre sélection/composition qu'une fois le
    // premier entièrement réglé (sinon les deux liraient les mêmes retenus
    // avant que l'un ne les marque dits → point parlé deux fois).
    {
        const order: string[] = [];
        let releaseA: () => void = () => {};
        const gateA = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        let calls = 0;
        const orderEngine = new ProactiveEngine(
            cfg(),
            {
                ...deps,
                complete: async () => {
                    calls++;
                    if (calls === 1) {
                        order.push('start-A');
                        await gateA;
                        order.push('end-A');
                        return 'Pendant ton absence, le resto est passé à 130 % du budget.';
                    }
                    order.push('start-B');
                    order.push('end-B');
                    return 'Avant de partir, rien à signaler.';
                },
            },
            {
                dedup: new Dedup(),
                journal: new ProactiveJournal(tmpFile('j4.json')),
                held: new HeldQueue(),
                said: new SaidMemory(),
            },
        );
        await orderEngine.ingest({
            source: 'genkin',
            key: 'order-test',
            kind: 'digest',
            importance: 'info',
            subject: 'Test ordre des moments',
            facts: ['fait'],
            at: NOW,
        });
        const pA = orderEngine.handleMoment('moment-return', 'retour');
        const pB = orderEngine.handleMoment('moment-departure', 'départ');
        releaseA();
        await Promise.all([pA, pB]);
        assert.deepStrictEqual(
            order,
            ['start-A', 'end-A', 'start-B', 'end-B'],
            'le second moment ne démarre qu’après la fin complète du premier',
        );
    }

    console.log('All engine-judge tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
