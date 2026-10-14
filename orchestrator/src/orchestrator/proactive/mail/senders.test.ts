import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SendersFile,
    SenderStore,
    labelFor,
    newKeepSender,
    newSpamSender,
    resolveSender,
    validateSendersFile,
} from './senders';

const now = 1000;

function file(): SendersFile {
    const qonto = newKeepSender(
        {
            match: 'qonto.com',
            name: 'Qonto',
            read: 'rules',
            rules: [
                { subject: 'rapport mensuel', read: false },
                { subject: 'contact', read: true },
            ],
            readDefault: false,
        },
        now,
    );
    const exact = newKeepSender(
        { match: 'ceo@qonto.com', name: 'CEO', read: 'always' },
        now,
    );
    const never = newKeepSender(
        { match: 'news.example.org', name: 'News', read: 'never' },
        now,
    );
    const spam = newSpamSender('spam.io', now);
    const spamKept = newSpamSender('qonto.com', now);
    return {
        version: 3,
        keep: [qonto, exact, never],
        spam: [spam, spamKept],
    };
}

function run() {
    const f = file();
    const r1 = resolveSender(f, {
        from: 'Qonto <hi@qonto.com>',
        subject: 'Rapport mensuel de mai',
    });
    assert.strictEqual(r1.kind, 'keep');
    if (r1.kind === 'keep') {
        assert.strictEqual(r1.read, false);
        assert.strictEqual(r1.label, 'Boîtes/Qonto');
    }
    const r2 = resolveSender(f, {
        from: 'hi@qonto.com',
        subject: 'Demande de contact',
    });
    assert.ok(r2.kind === 'keep' && r2.read === true);
    const r3 = resolveSender(f, { from: 'hi@qonto.com', subject: 'Autre' });
    assert.ok(r3.kind === 'keep' && r3.read === false);

    const r4 = resolveSender(f, { from: 'x@news.example.org', subject: 'a' });
    assert.ok(r4.kind === 'keep' && r4.read === false);
    const r5 = resolveSender(f, { from: 'CEO <ceo@qonto.com>', subject: 'a' });
    assert.ok(r5.kind === 'keep' && r5.sender.name === 'CEO' && r5.read);

    // keep bat spam (qonto.com est aussi en spam)
    assert.strictEqual(
        resolveSender(f, { from: 'a@qonto.com', subject: 'x' }).kind,
        'keep',
    );
    assert.strictEqual(
        resolveSender(f, { from: 'a@spam.io', subject: 'x' }).kind,
        'spam',
    );
    assert.strictEqual(
        resolveSender(f, { from: 'a@other.fr', subject: 'x' }).kind,
        'inbox',
    );

    assert.strictEqual(labelFor(f.keep[0]), 'Boîtes/Qonto');

    // validation
    assert.doesNotThrow(() =>
        validateSendersFile(JSON.parse(JSON.stringify(f))),
    );
    const bad = (mut: (g: any) => void, re: RegExp) => {
        const g = JSON.parse(JSON.stringify(f));
        mut(g);
        assert.throws(() => validateSendersFile(g), re);
    };
    bad((g) => (g.keep[0].name = 'a/b'), /nom/i);
    bad((g) => (g.keep[0].rules[0].subject = '('), /expression|régulière/i);
    bad((g) => (g.keep[1].id = g.keep[0].id), /id/i);
    bad((g) => (g.keep[0].read = 'x'), /read|lecture/i);
    bad((g) => (g.spam[0].match = 'a'), /2/);
    assert.throws(() => validateSendersFile(null));

    // store
    const tmp = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'senders-')),
        'sub',
        'mail-senders.json',
    );
    const s = new SenderStore(tmp);
    assert.strictEqual(s.exists(), false);
    const k = newKeepSender({ match: 'a.fr', name: 'A' }, now);
    s.upsertKeep(k);
    s.upsertSpam(newSpamSender('b.fr', now));
    assert.strictEqual(s.exists(), true);
    s.recordHit(k.id, 5);
    s.recordHit(k.id, 6);
    const s2 = new SenderStore(tmp);
    assert.strictEqual(s2.keep().length, 1);
    assert.strictEqual(s2.keep()[0].hits, 2);
    assert.strictEqual(s2.keep()[0].lastHitAt, 6);
    assert.strictEqual(s2.spam().length, 1);
    assert.strictEqual(s2.remove(k.id), true);
    assert.strictEqual(s2.remove(k.id), false);
    assert.throws(() => s2.replace({ version: 3, keep: [{}], spam: [] }));
    assert.strictEqual(s2.keep().length, 0);

    console.log('senders: all tests passed');
}
run();
