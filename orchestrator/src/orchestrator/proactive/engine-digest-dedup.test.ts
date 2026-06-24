import assert from 'assert';
import * as fs from 'fs';
import { ProactiveEngine } from './index';
import { DigestBuffer } from './digest';
import { Dedup } from './dedup';
import type { CandidateEvent, ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

function cfg(): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        digestTime: '07:00',
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
    };
}

function event(subject: string): CandidateEvent {
    return {
        watcherId: 'w',
        subject,
        importance: 'utile',
        facts: `fait ${subject}`,
    };
}

// Un sujet ajouté au digest (ex. pendant les heures de silence) puis émis en
// direct le matin ne doit PAS être répété par le flush du digest.
async function run(): Promise<void> {
    const digestFile = 'data/proactive-digest.dd.json';
    const dedupFile = 'data/proactive-dedup.dd.json';
    fs.rmSync(digestFile, { force: true });
    fs.rmSync(dedupFile, { force: true });

    const notified: string[] = [];
    const deps: ProactiveDeps = {
        complete: async (_s, u) => `dit: ${u}`,
        notify: async (t) => void notified.push(t),
        speak: async () => {},
        presenceState: () => 'away' as PresenceState,
        subscribePresence: () => {},
        deviceHandler: async () => null,
        runScene: async () => ({ success: true }),
        // 10:05, hors heures de silence, après digestTime
        now: () => new Date('2026-05-29T10:05:00').getTime(),
    };

    const digest = new DigestBuffer(digestFile);
    // simulate : « heat » a été bufferisé pendant la nuit (heures de silence)
    digest.add(event('heat'));
    assert.strictEqual(digest.size(), 1);

    const eng = new ProactiveEngine(cfg(), deps, digest, new Dedup(dedupFile));

    // le matin, le même sujet passe les gates → émis en direct
    await eng.processCandidate(event('heat'));
    assert.strictEqual(notified.length, 1, 'une seule notif directe');
    assert.strictEqual(
        digest.size(),
        0,
        'le sujet émis en direct est purgé du digest',
    );

    // le flush du digest ne doit donc rien renvoyer (plus de doublon)
    await eng.maybeFlushDigest();
    assert.strictEqual(
        notified.length,
        1,
        'pas de seconde notif via le digest',
    );

    fs.rmSync(digestFile, { force: true });
    fs.rmSync(dedupFile, { force: true });
    console.log('All engine-digest-dedup tests passed');
}

run();
