import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import type { Event } from './events';
import type { CandidateEvent, ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// La source de test ('w') n'est ni un connecteur ni un moment : sa première
// ingestion déclare la brique implicite `external:w` (declareExternal →
// saveConfig). YUI_DATA_DIR doit donc être posé AVANT que les modules ne
// résolvent leurs dataPath() au chargement — via require(), pas un import
// hissé (même contrainte que engine-action.test.ts).
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-e-'));
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');

function baseConfig(over: Partial<ProactiveConfig> = {}): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        digestTime: '07:00',
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
        // Ces tests valident le pipeline HISTORIQUE (seuil de bavardage +
        // reformulation) — le juge à budget a les siens (judge.test.ts).
        bricks: { judge: { enabled: false } },
        ...over,
    };
}

function makeDeps(over: Partial<ProactiveDeps> = {}): {
    deps: ProactiveDeps;
    notified: string[];
    spoken: string[];
} {
    const notified: string[] = [];
    const spoken: string[] = [];
    const deps: ProactiveDeps = {
        complete: async (_s, u) => `reformulé: ${u}`,
        notify: async (t) => void notified.push(t),
        speak: async (t) => void spoken.push(t),
        presenceState: () => 'home' as PresenceState,
        subscribePresence: () => () => {},
        deviceHandler: async () => null,
        runScene: async () => ({ success: true }),
        now: () => new Date('2026-05-29T14:00:00').getTime(),
        ...over,
    };
    return { deps, notified, spoken };
}

function ev(over: Partial<CandidateEvent> = {}): CandidateEvent {
    return {
        watcherId: 'w',
        subject: 's',
        importance: 'utile',
        facts: 'un fait',
        ...over,
    };
}

/** Dédup et retenus en mémoire : aucun test ne doit toucher data/. */
function engine(
    cfg: ProactiveConfig,
    deps: ProactiveDeps,
    dedup = new Dedup(),
) {
    return new ProactiveEngine(cfg, deps, { dedup, held: new HeldQueue() });
}

async function run(): Promise<void> {
    // 1. événement utile, présent → FCM + TTS, message reformulé
    {
        const { deps, notified, spoken } = makeDeps();
        const eng = engine(baseConfig(), deps);
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 1);
        assert.strictEqual(notified[0], 'reformulé: un fait');
        assert.strictEqual(spoken.length, 1);
    }

    // 2. absent → FCM seulement
    {
        const { deps, notified, spoken } = makeDeps({
            presenceState: () => 'away',
        });
        const eng = engine(baseConfig(), deps);
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 1);
        assert.strictEqual(spoken.length, 0);
    }

    // 3. sous le seuil (info en mode normal) → retenu, pas de notif
    {
        const { deps, notified } = makeDeps();
        const eng = engine(baseConfig(), deps);
        await eng.processCandidate(ev({ importance: 'info' }));
        assert.strictEqual(notified.length, 0);
        assert.strictEqual(eng.heldCount(), 1);
    }

    // 4. anti-répétition → seconde occurrence ignorée
    {
        const { deps, notified } = makeDeps();
        const eng = engine(baseConfig(), deps);
        await eng.processCandidate(ev());
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 1);
    }

    // 5. heures de silence : le non urgent est retenu, urgent et critique passent
    {
        const night = () => new Date('2026-05-29T23:30:00').getTime();
        const { deps, notified } = makeDeps({ now: night });
        const eng = engine(baseConfig(), deps);
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 0);
        assert.strictEqual(eng.heldCount(), 1);
        await eng.processCandidate(
            ev({ subject: 'fire', importance: 'critique' }),
        );
        assert.strictEqual(notified.length, 1);
        await eng.processCandidate(
            ev({ subject: 'leak', importance: 'urgent' }),
        );
        assert.strictEqual(
            notified.length,
            2,
            "l'urgent traverse les heures de silence",
        );
    }

    // 6. template → court-circuite le LLM
    {
        const { deps, notified } = makeDeps();
        const eng = engine(baseConfig(), deps);
        await eng.processCandidate(ev({ template: 'texte brut' }));
        assert.strictEqual(notified[0], 'texte brut');
    }

    // 7. LLM répond RIEN → rien émis
    {
        const { deps, notified } = makeDeps({ complete: async () => 'RIEN' });
        const eng = engine(baseConfig(), deps);
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 0);
    }

    // 8. répétition DANS la fenêtre cooldown → aucun appel LLM, aucune notif
    {
        let completeCalls = 0;
        const { deps, notified } = makeDeps({
            complete: async (_s, u) => {
                completeCalls++;
                return `reformulé: ${u}`;
            },
        });
        const eng = engine(baseConfig({ defaultCooldownMin: 30 }), deps);
        await eng.processCandidate(ev()); // t=14:00
        await eng.processCandidate(ev()); // même instant → dans la fenêtre
        assert.strictEqual(notified.length, 1);
        assert.strictEqual(completeCalls, 1); // le 2e n'a pas consulté le LLM
    }

    // 9. hors fenêtre + LLM répond RIEN → pas de notif, cooldown ré-armé,
    //    message précédent préservé et fourni au LLM
    {
        let tick = new Date('2026-05-29T14:00:00').getTime();
        const seenUserPayloads: string[] = [];
        const { deps, notified } = makeDeps({
            now: () => tick,
            complete: async (_s, u) => {
                seenUserPayloads.push(u);
                // 1er appel : formule ; appels suivants : RIEN
                return seenUserPayloads.length === 1
                    ? 'Il fait 28 degrés, au-dessus des normales'
                    : 'RIEN';
            },
        });
        const dedup = new Dedup();
        const eng = engine(baseConfig({ defaultCooldownMin: 30 }), deps, dedup);
        await eng.processCandidate(ev({ subject: 'temp' }));
        assert.strictEqual(notified.length, 1);

        // +40 min : hors fenêtre → consulte le LLM → RIEN → pas de notif
        tick += 40 * 60_000;
        await eng.processCandidate(ev({ subject: 'temp' }));
        assert.strictEqual(notified.length, 1); // toujours 1
        // le LLM a bien reçu le dernier message dans son payload
        assert.ok(
            seenUserPayloads[1].includes('Il fait 28 degrés'),
            'le payload doit contenir le dernier message',
        );
        // le message d'origine est conservé (pas écrasé par le RIEN) — la clé
        // de dédup du bus est `source:key`
        assert.strictEqual(
            dedup.lastMessage('w:temp'),
            'Il fait 28 degrés, au-dessus des normales',
        );

        // +10 min après le RIEN (ré-armé) → de nouveau dans la fenêtre → silence
        const payloadsBefore = seenUserPayloads.length;
        tick += 10 * 60_000;
        await eng.processCandidate(ev({ subject: 'temp' }));
        assert.strictEqual(seenUserPayloads.length, payloadsBefore); // pas de nouvel appel
    }

    // 10. hors fenêtre + LLM répond un texte → notif + message mis à jour
    {
        let tick = new Date('2026-05-29T14:00:00').getTime();
        let n = 0;
        const { deps, notified } = makeDeps({
            now: () => tick,
            complete: async () => (++n === 1 ? 'message un' : 'message deux'),
        });
        const dedup = new Dedup();
        const eng = engine(baseConfig({ defaultCooldownMin: 30 }), deps, dedup);
        await eng.processCandidate(ev({ subject: 'temp' }));
        tick += 40 * 60_000;
        await eng.processCandidate(ev({ subject: 'temp' }));
        assert.strictEqual(notified.length, 2);
        assert.strictEqual(notified[1], 'message deux');
        assert.strictEqual(dedup.lastMessage('w:temp'), 'message deux');
    }

    // 11. LLM down (throw) → fail-open : repli sur facts, notif émise
    {
        const { deps, notified } = makeDeps({
            complete: async () => {
                throw new Error('Connection error.');
            },
        });
        const eng = engine(baseConfig(), deps);
        await eng.processCandidate(ev({ facts: 'un fait brut' }));
        assert.strictEqual(notified.length, 1);
        assert.strictEqual(notified[0], 'un fait brut');
    }

    // 12. `declareExternal` fusionne sur la config FRAÎCHE du disque, pas sur
    // l'instantané de l'engine : un `PUT /proactive` arrivé entre-temps (ici
    // simulé en écrivant le fichier après la construction) ne doit pas être
    // écrasé par la déclaration de la nouvelle brique externe.
    {
        const { deps } = makeDeps();
        const eng = engine(baseConfig(), deps);
        const cfgFile = dataPath('proactive.json');
        fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
        fs.writeFileSync(
            cfgFile,
            JSON.stringify({
                enabled: true,
                bricks: { judge: { enabled: false } },
            }),
        );
        const koyaEvent: Event = {
            source: 'koya',
            key: 'x',
            kind: 'alert',
            importance: 'utile',
            subject: 'x',
            facts: [],
            at: deps.now!(),
        };
        await eng.ingest(koyaEvent);
        const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
        assert.strictEqual(
            onDisk.bricks.judge.enabled,
            false,
            "l'édit admin sur disque n'est pas écrasé",
        );
        assert.strictEqual(onDisk.bricks['external:koya'].enabled, true);
    }

    console.log('All engine tests passed');
}

run();
