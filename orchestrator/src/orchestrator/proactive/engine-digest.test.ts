import assert from 'assert';
import * as fs from 'fs';
import { ProactiveEngine } from './index';
import { DigestBuffer } from './digest';
import { Dedup } from './dedup';
import type { ProactiveConfig, ProactiveDeps } from './types';
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

async function run(): Promise<void> {
    const file = 'data/proactive-digest.td.json';
    fs.rmSync(file, { force: true });
    const notified: string[] = [];
    const deps: ProactiveDeps = {
        complete: async (_s, u) => `résumé(${u.split('\n').length} pts)`,
        notify: async (t) => void notified.push(t),
        speak: async () => {},
        presenceState: () => 'away' as PresenceState,
        subscribePresence: () => {},
        deviceHandler: async () => null,
        runScene: async () => ({ success: true }),
        now: () => new Date('2026-05-29T07:05:00').getTime(),
    };
    const digest = new DigestBuffer(file);
    digest.add({
        watcherId: 'w',
        subject: 'a',
        importance: 'info',
        facts: 'fait a',
    });
    digest.add({
        watcherId: 'w',
        subject: 'b',
        importance: 'info',
        facts: 'fait b',
    });

    const eng = new ProactiveEngine(cfg(), deps, digest, new Dedup());
    await eng.maybeFlushDigest();

    assert.strictEqual(notified.length, 1);
    assert.ok(notified[0].startsWith('résumé('));
    assert.strictEqual(digest.size(), 0);

    // second appel le même jour après flush → rien
    await eng.maybeFlushDigest();
    assert.strictEqual(notified.length, 1);

    fs.rmSync(file, { force: true });
    console.log('All engine-digest tests passed');
}

run();
