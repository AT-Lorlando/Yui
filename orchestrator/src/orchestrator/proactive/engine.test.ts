import assert from 'assert';
import { ProactiveEngine } from './index';
import { DigestBuffer } from './digest';
import { Dedup } from './dedup';
import type { CandidateEvent, ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

function baseConfig(over: Partial<ProactiveConfig> = {}): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        digestTime: '07:00',
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
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
        subscribePresence: () => {},
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

async function run(): Promise<void> {
    // 1. événement utile, présent → FCM + TTS, message reformulé
    {
        const file = `data/proactive-digest.t1.json`;
        const { deps, notified, spoken } = makeDeps();
        const eng = new ProactiveEngine(
            baseConfig(),
            deps,
            new DigestBuffer(file),
            new Dedup(),
        );
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 1);
        assert.strictEqual(notified[0], 'reformulé: un fait');
        assert.strictEqual(spoken.length, 1);
        require('fs').rmSync(file, { force: true });
    }

    // 2. absent → FCM seulement
    {
        const file = `data/proactive-digest.t2.json`;
        const { deps, notified, spoken } = makeDeps({
            presenceState: () => 'away',
        });
        const eng = new ProactiveEngine(
            baseConfig(),
            deps,
            new DigestBuffer(file),
            new Dedup(),
        );
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 1);
        assert.strictEqual(spoken.length, 0);
        require('fs').rmSync(file, { force: true });
    }

    // 3. sous le seuil (info en mode normal) → dévié vers le digest, pas de notif
    {
        const file = `data/proactive-digest.t3.json`;
        const { deps, notified } = makeDeps();
        const digest = new DigestBuffer(file);
        const eng = new ProactiveEngine(
            baseConfig(),
            deps,
            digest,
            new Dedup(),
        );
        await eng.processCandidate(ev({ importance: 'info' }));
        assert.strictEqual(notified.length, 0);
        assert.strictEqual(digest.size(), 1);
        require('fs').rmSync(file, { force: true });
    }

    // 4. anti-répétition → seconde occurrence ignorée
    {
        const file = `data/proactive-digest.t4.json`;
        const { deps, notified } = makeDeps();
        const eng = new ProactiveEngine(
            baseConfig(),
            deps,
            new DigestBuffer(file),
            new Dedup(),
        );
        await eng.processCandidate(ev());
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 1);
        require('fs').rmSync(file, { force: true });
    }

    // 5. heures de silence + non critique → digest ; critique → passe
    {
        const file = `data/proactive-digest.t5.json`;
        const night = () => new Date('2026-05-29T23:30:00').getTime();
        const { deps, notified } = makeDeps({ now: night });
        const digest = new DigestBuffer(file);
        const eng = new ProactiveEngine(
            baseConfig(),
            deps,
            digest,
            new Dedup(),
        );
        await eng.processCandidate(ev({ importance: 'urgent' }));
        assert.strictEqual(notified.length, 0);
        assert.strictEqual(digest.size(), 1);
        await eng.processCandidate(
            ev({ subject: 'fire', importance: 'critique' }),
        );
        assert.strictEqual(notified.length, 1);
        require('fs').rmSync(file, { force: true });
    }

    // 6. template → court-circuite le LLM
    {
        const file = `data/proactive-digest.t6.json`;
        const { deps, notified } = makeDeps();
        const eng = new ProactiveEngine(
            baseConfig(),
            deps,
            new DigestBuffer(file),
            new Dedup(),
        );
        await eng.processCandidate(ev({ template: 'texte brut' }));
        assert.strictEqual(notified[0], 'texte brut');
        require('fs').rmSync(file, { force: true });
    }

    // 7. LLM répond RIEN → rien émis
    {
        const file = `data/proactive-digest.t7.json`;
        const { deps, notified } = makeDeps({ complete: async () => 'RIEN' });
        const eng = new ProactiveEngine(
            baseConfig(),
            deps,
            new DigestBuffer(file),
            new Dedup(),
        );
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 0);
        require('fs').rmSync(file, { force: true });
    }

    // 8. répétition DANS la fenêtre cooldown → aucun appel LLM, aucune notif
    {
        const file = `data/proactive-digest.t8.json`;
        let completeCalls = 0;
        const { deps, notified } = makeDeps({
            complete: async (_s, u) => {
                completeCalls++;
                return `reformulé: ${u}`;
            },
        });
        const eng = new ProactiveEngine(
            baseConfig({ defaultCooldownMin: 30 }),
            deps,
            new DigestBuffer(file),
            new Dedup(),
        );
        await eng.processCandidate(ev()); // t=14:00
        await eng.processCandidate(ev()); // même instant → dans la fenêtre
        assert.strictEqual(notified.length, 1);
        assert.strictEqual(completeCalls, 1); // le 2e n'a pas consulté le LLM
        require('fs').rmSync(file, { force: true });
    }

    // 9. hors fenêtre + LLM répond RIEN → pas de notif, cooldown ré-armé,
    //    message précédent préservé et fourni au LLM
    {
        const file = `data/proactive-digest.t9.json`;
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
        const eng = new ProactiveEngine(
            baseConfig({ defaultCooldownMin: 30 }),
            deps,
            new DigestBuffer(file),
            dedup,
        );
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
        // le message d'origine est conservé (pas écrasé par le RIEN)
        assert.strictEqual(
            dedup.lastMessage('temp'),
            'Il fait 28 degrés, au-dessus des normales',
        );

        // +10 min après le RIEN (ré-armé) → de nouveau dans la fenêtre → silence
        const payloadsBefore = seenUserPayloads.length;
        tick += 10 * 60_000;
        await eng.processCandidate(ev({ subject: 'temp' }));
        assert.strictEqual(seenUserPayloads.length, payloadsBefore); // pas de nouvel appel
        require('fs').rmSync(file, { force: true });
    }

    // 10. hors fenêtre + LLM répond un texte → notif + message mis à jour
    {
        const file = `data/proactive-digest.t10.json`;
        let tick = new Date('2026-05-29T14:00:00').getTime();
        let n = 0;
        const { deps, notified } = makeDeps({
            now: () => tick,
            complete: async () => (++n === 1 ? 'message un' : 'message deux'),
        });
        const dedup = new Dedup();
        const eng = new ProactiveEngine(
            baseConfig({ defaultCooldownMin: 30 }),
            deps,
            new DigestBuffer(file),
            dedup,
        );
        await eng.processCandidate(ev({ subject: 'temp' }));
        tick += 40 * 60_000;
        await eng.processCandidate(ev({ subject: 'temp' }));
        assert.strictEqual(notified.length, 2);
        assert.strictEqual(notified[1], 'message deux');
        assert.strictEqual(dedup.lastMessage('temp'), 'message deux');
        require('fs').rmSync(file, { force: true });
    }

    // 11. LLM down (throw) → fail-open : repli sur facts, notif émise
    {
        const file = `data/proactive-digest.t11.json`;
        const { deps, notified } = makeDeps({
            complete: async () => {
                throw new Error('Connection error.');
            },
        });
        const eng = new ProactiveEngine(
            baseConfig(),
            deps,
            new DigestBuffer(file),
            new Dedup(),
        );
        await eng.processCandidate(ev({ facts: 'un fait brut' }));
        assert.strictEqual(notified.length, 1);
        assert.strictEqual(notified[0], 'un fait brut');
        require('fs').rmSync(file, { force: true });
    }

    console.log('All engine tests passed');
}

run();
