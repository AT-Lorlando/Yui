import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProactiveJournal } from './journal';

async function run(): Promise<void> {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'yui-journal-')),
        'journal.json',
    );
    const j = new ProactiveJournal(file);
    for (const at of [100, 200, 300, 400]) {
        j.record({
            at,
            source: 's',
            subject: `x${at}`,
            channel: 'speak',
            message: 'm',
        });
    }
    assert.deepStrictEqual(
        j.list(50).map((e) => e.at),
        [400, 300, 200, 100],
    );
    // `before` est exclusif : strictement plus ancien.
    assert.deepStrictEqual(
        j.list(50, 300).map((e) => e.at),
        [200, 100],
    );
    assert.deepStrictEqual(
        j.list(1, 400).map((e) => e.at),
        [300],
    );
    assert.deepStrictEqual(j.list(50, 100), []);

    // ── manualSummary : manuelles seulement, récentes d'abord, 10 max, 14 j ──
    const DAY = 24 * 3600_000;
    const NOW = 100 * DAY;
    assert.strictEqual(j.manualSummary(NOW), '', 'aucun manuel → vide');
    const ev = {
        source: 'koya',
        key: 'disk',
        kind: 'alert' as const,
        importance: 'utile' as const,
        subject: 'Disque plein',
        facts: ['92 %'],
        at: NOW - 15 * DAY,
    };
    j.record({
        at: NOW - 15 * DAY,
        source: 'koya',
        subject: 'old',
        channel: 'speak',
        message: 'm',
        manual: true,
        event: ev,
    });
    assert.strictEqual(j.manualSummary(NOW), '', 'hors fenêtre de 14 j');
    for (let i = 0; i < 12; i++) {
        j.record({
            at: NOW - (12 - i) * 3600_000,
            source: 'koya',
            subject: `k${i}`,
            channel: i % 2 ? 'skip' : 'notify',
            message: 'm',
            manual: true,
        });
    }
    j.record({
        at: NOW,
        source: 'auto',
        subject: 'not-manual',
        channel: 'speak',
        message: 'm',
    });
    const lines = j.manualSummary(NOW).split('\n');
    assert.strictEqual(lines.length, 10, 'limite 10');
    assert.strictEqual(lines[0], '[koya] k11 → skip', 'plus récente d’abord');
    assert.strictEqual(lines[9], '[koya] k2 → notify');
    assert.ok(!lines.some((l) => l.includes('not-manual')));
    assert.strictEqual(j.manualSummary(NOW, 3).split('\n').length, 3);

    // Les décisions manuelles ne consomment pas le budget du juge.
    const jb = new ProactiveJournal(
        path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'yui-journal-')),
            'j.json',
        ),
    );
    jb.record({
        at: NOW,
        source: 'koya',
        subject: 'm',
        channel: 'speak',
        message: 'm',
        kind: 'event',
        manual: true,
    });
    assert.strictEqual(jb.spentToday(NOW), 0, 'manuel hors budget');
    jb.record({
        at: NOW,
        source: 'koya',
        subject: 'j',
        channel: 'speak',
        message: 'm',
        kind: 'event',
    });
    assert.strictEqual(jb.spentToday(NOW), 1, 'verdict du juge compté');
    jb.record({
        at: NOW,
        source: 'mail',
        subject: 'mail-order-o1',
        channel: 'speak',
        message: 'Ce que tu attendais : …',
        kind: 'event',
        requested: true,
    });
    assert.strictEqual(jb.spentToday(NOW), 1, 'attente demandée hors budget');

    // `event` et `manual` persistés puis relus.
    const reread = new ProactiveJournal(file);
    const old = reread.list(300).find((e) => e.subject === 'old');
    assert.ok(old);
    assert.strictEqual(old.manual, true);
    assert.deepStrictEqual(old.event, ev);
    console.log('All journal tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
