import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ProactiveEngine } from './index';
import { DigestBuffer } from './digest';
import type { CandidateEvent, ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

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
    const histFile = path.resolve(
        process.cwd(),
        'data/automation-history.json',
    );
    const autoFile = path.resolve(process.cwd(), 'data/automations.json');
    const histBak = fs.existsSync(histFile)
        ? fs.readFileSync(histFile, 'utf-8')
        : null;
    const autoBak = fs.existsSync(autoFile)
        ? fs.readFileSync(autoFile, 'utf-8')
        : null;

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
        fs.writeFileSync(histFile, '[]');
        fs.writeFileSync(autoFile, '[]');
        {
            const calls: { tool: string }[] = [];
            const eng = new ProactiveEngine(
                cfg(),
                deps(calls),
                new DigestBuffer('data/proactive-digest.ta.json'),
            );
            await eng.processCandidate(evt());
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].tool, 'irrigation_start');
            fs.rmSync('data/proactive-digest.ta.json', { force: true });
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
                new DigestBuffer('data/proactive-digest.tb.json'),
            );
            await eng.processCandidate(evt());
            assert.strictEqual(calls.length, 0); // action bridée
            fs.rmSync('data/proactive-digest.tb.json', { force: true });
        }

        console.log('All engine-action tests passed');
    } finally {
        if (histBak !== null) fs.writeFileSync(histFile, histBak);
        else fs.rmSync(histFile, { force: true });
        if (autoBak !== null) fs.writeFileSync(autoFile, autoBak);
        else fs.rmSync(autoFile, { force: true });
    }
}

run();
