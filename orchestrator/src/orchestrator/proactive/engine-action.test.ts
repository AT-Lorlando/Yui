import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import type { CandidateEvent, ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// Isolate ALL data-file I/O into a temp dir. YUI_DATA_DIR must be set before
// the engine modules resolve their dataPath() constants at load time, so they
// are pulled in via require() (which runs after this assignment) rather than a
// hoisted import. This keeps the test from touching the real data/ tree.
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ea-'));
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { DigestBuffer } = require('./digest') as typeof import('./digest');
const { Dedup } = require('./dedup') as typeof import('./dedup');

const WL = [
    {
        id: 'extra-watering',
        tag: 'irrigation',
        action: { tool: 'irrigation_start', args: { zone: 'plantes' } },
    },
];

function cfg(over: Partial<ProactiveConfig> = {}): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        digestTime: '07:00',
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: WL,
        ...over,
    };
}

function evt(): CandidateEvent {
    return {
        watcherId: 'weather',
        subject: 'heat',
        importance: 'utile',
        facts: 'forte chaleur',
        proposedAction: { id: 'extra-watering', tag: 'irrigation' },
    };
}

async function run(): Promise<void> {
    const histFile = dataPath('automation-history.json');
    const autoFile = dataPath('automations.json');
    const digestA = path.join(
        process.env.YUI_DATA_DIR!,
        'proactive-digest.ta.json',
    );
    const digestB = path.join(
        process.env.YUI_DATA_DIR!,
        'proactive-digest.tb.json',
    );

    function deps(calls: { tool: string }[]): ProactiveDeps {
        return {
            complete: async (_s, u) => u,
            notify: async () => {},
            speak: async () => {},
            presenceState: () => 'away' as PresenceState,
            subscribePresence: () => {},
            deviceHandler: async (tool) => {
                calls.push({ tool });
                return null;
            },
            runScene: async () => ({ success: true }),
            now: () => new Date('2026-05-29T14:00:00').getTime(),
        };
    }

    try {
        // a. aucune automation conflictuelle → action exécutée
        fs.mkdirSync(path.dirname(histFile), { recursive: true });
        fs.mkdirSync(path.dirname(autoFile), { recursive: true });
        fs.writeFileSync(histFile, '[]');
        fs.writeFileSync(autoFile, '[]');
        {
            const calls: { tool: string }[] = [];
            const eng = new ProactiveEngine(
                cfg(),
                deps(calls),
                new DigestBuffer(digestA),
                new Dedup(),
            );
            await eng.processCandidate(evt());
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].tool, 'irrigation_start');
        }

        // b. automation activée avec le même tag → action bridée (mais notif ok)
        fs.writeFileSync(
            autoFile,
            JSON.stringify([
                {
                    id: 'x',
                    name: 'Arrosage',
                    trigger: { type: 'cron', expr: '0 8 * * *' },
                    action: { type: 'scene', sceneId: 's' },
                    enabled: true,
                    createdAt: 0,
                    tag: 'irrigation',
                },
            ]),
        );
        {
            const calls: { tool: string }[] = [];
            const eng = new ProactiveEngine(
                cfg(),
                deps(calls),
                new DigestBuffer(digestB),
                new Dedup(),
            );
            await eng.processCandidate(evt());
            assert.strictEqual(calls.length, 0); // action bridée
        }

        console.log('All engine-action tests passed');
    } finally {
        fs.rmSync(process.env.YUI_DATA_DIR!, { recursive: true, force: true });
    }
}

run();
