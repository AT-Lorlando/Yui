import assert from 'assert';
import { isActionBlocked } from './guard';
import type { AutomationHistoryEntry } from '../history';

function run(): void {
    const windowMs = 60 * 60_000; // 60 min
    const now = 1_000_000_000;

    // bloqué : une automation activée possède le tag
    assert.strictEqual(
        isActionBlocked({
            tag: 'irrigation',
            now,
            windowMs,
            history: [],
            enabledAutomationTags: ['irrigation'],
        }),
        true,
    );

    // bloqué : une automation a touché le tag récemment
    const recent: AutomationHistoryEntry[] = [
        {
            id: 'a',
            name: 'x',
            action: { type: 'scene', sceneId: 's' },
            tag: 'irrigation',
            firedAt: now - 10 * 60_000,
        },
    ];
    assert.strictEqual(
        isActionBlocked({
            tag: 'irrigation',
            now,
            windowMs,
            history: recent,
            enabledAutomationTags: [],
        }),
        true,
    );

    // pas bloqué : firing trop ancien
    const old: AutomationHistoryEntry[] = [
        {
            id: 'a',
            name: 'x',
            action: { type: 'scene', sceneId: 's' },
            tag: 'irrigation',
            firedAt: now - 120 * 60_000,
        },
    ];
    assert.strictEqual(
        isActionBlocked({
            tag: 'irrigation',
            now,
            windowMs,
            history: old,
            enabledAutomationTags: [],
        }),
        false,
    );

    // pas bloqué : tag différent
    assert.strictEqual(
        isActionBlocked({
            tag: 'irrigation',
            now,
            windowMs,
            history: [],
            enabledAutomationTags: ['shutters'],
        }),
        false,
    );

    console.log('All guard tests passed');
}

run();
