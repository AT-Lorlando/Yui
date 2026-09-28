import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
process.env.YUI_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yui-journal-'),
);
const J = require('./journal') as typeof import('./journal');

const decision = (i: number): import('./journal').MailDecision => ({
    at: i,
    mailId: `m${i}`,
    from: 'a@b.c',
    subject: 's',
    category: 'lire',
    stage: 'fallback',
    applied: false,
});

async function run() {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'yui-journal-file-'))!,
        'mail-journal.json',
    );

    // anneau borné à MAIL_JOURNAL_MAX
    const j = new J.MailJournal(file);
    for (let i = 0; i < 205; i++) j.add(decision(i));
    assert.strictEqual(j.size(), J.MAIL_JOURNAL_MAX);

    // list(n) = les n plus récentes, la plus récente d'abord
    const last3 = j.list(3);
    assert.deepStrictEqual(
        last3.map((d) => d.mailId),
        ['m204', 'm203', 'm202'],
    );

    // persistance : rechargée depuis le fichier par une nouvelle instance
    const reloaded = new J.MailJournal(file);
    assert.strictEqual(reloaded.size(), J.MAIL_JOURNAL_MAX);
    assert.strictEqual(reloaded.list(1)[0].mailId, 'm204');

    // fichier corrompu → vide plutôt que planter
    const badFile = path.join(path.dirname(file), 'mail-journal-bad.json');
    fs.writeFileSync(badFile, '{ not json');
    const corrupted = new J.MailJournal(badFile);
    assert.strictEqual(corrupted.size(), 0);
    assert.deepStrictEqual(corrupted.list(), []);

    // fichier par défaut résolu via dataPath('mail-journal.json')
    const def = new J.MailJournal();
    assert.ok(J.MailJournal.defaultFile().endsWith('mail-journal.json'));
    def.add(decision(1));
    assert.strictEqual(def.size(), 1);

    console.log('journal ok');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
