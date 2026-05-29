import assert from 'assert';
import { ProactiveEngine } from './index';
import { DigestBuffer } from './digest';
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
        const eng = new ProactiveEngine(baseConfig(), deps, digest);
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
        const eng = new ProactiveEngine(baseConfig(), deps, digest);
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
        );
        await eng.processCandidate(ev());
        assert.strictEqual(notified.length, 0);
        require('fs').rmSync(file, { force: true });
    }

    console.log('All engine tests passed');
}

run();
