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
    console.log('All storyArchive tests passed');
}

run();
