import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    upsertIndexEntry,
    markFinished,
    listConversations,
    _setIndexFileForTests,
} from './storyArchive';

function run(): void {
    const tmp = path.join('/tmp', `story-index-test-${Date.now()}.json`);
    _setIndexFileForTests(tmp);

    upsertIndexEntry({
        id: '100',
        date: '2026-06-01',
        summary: '',
        domotics: false,
        source: 'app',
        finished: false,
    });
    let all = listConversations('all');
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].finished, false);

    assert.strictEqual(listConversations('resumable').length, 0);

    markFinished('100', 'lumières du salon éteintes le soir');
    all = listConversations('all');
    assert.strictEqual(all[0].finished, true);
    assert.strictEqual(all[0].summary, 'lumières du salon éteintes le soir');

    assert.strictEqual(listConversations('resumable').length, 1);

    upsertIndexEntry({
        id: '200',
        date: '2026-06-01',
        summary: 'porte verrouillée',
        domotics: true,
        source: 'voice',
        finished: true,
    });
    assert.strictEqual(listConversations('resumable').length, 1);
    assert.strictEqual(listConversations('all').length, 2);

    upsertIndexEntry({
        id: '300',
        date: '2026-06-01',
        summary: 'simulation',
        domotics: false,
        source: 'app',
        finished: true,
        parentId: '100',
    });
    assert.strictEqual(listConversations('resumable').length, 1);
    assert.strictEqual(listConversations('all').length, 3);

    fs.rmSync(tmp, { force: true });

    // ── purge protège les parents ────────────────────────────────
    const tmp2 = path.join('/tmp', `story-index-purge-${Date.now()}.json`);
    _setIndexFileForTests(tmp2);
    for (let n = 1; n <= 200; n++) {
        upsertIndexEntry({
            id: String(n),
            date: '2026-06-01',
            summary: '',
            domotics: false,
            source: 'app',
            finished: true,
        });
    }
    upsertIndexEntry({
        id: '201',
        date: '2026-06-01',
        summary: 'branche',
        domotics: false,
        source: 'app',
        finished: true,
        parentId: '1',
    });
    const purged = listConversations('all');
    assert.strictEqual(purged.length, 200);
    assert.ok(
        purged.some((e) => e.id === '1'),
        'parent protégé doit survivre',
    );
    assert.ok(
        !purged.some((e) => e.id === '2'),
        "'2' non protégé doit être purgé",
    );

    markFinished('nope', 'x');
    assert.strictEqual(listConversations('all').length, 200);

    fs.rmSync(tmp2, { force: true });

    console.log('All storyArchive tests passed');
}

run();
