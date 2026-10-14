import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MailRule } from './migrate';
import { migrateRulesToSenders, nameFromMatch, readRulesFile } from './migrate';

let n = 0;
function rule(
    when: MailRule['when'],
    category: string | null,
    extra: Partial<MailRule> = {},
): MailRule {
    return {
        id: `r${++n}`,
        when,
        then: { category },
        origin: 'user',
        confirmed: true,
        hits: 0,
        createdAt: 1000,
        ...extra,
    };
}

function run(): void {
    assert.strictEqual(nameFromMatch('qonto.com'), 'Qonto');
    assert.strictEqual(nameFromMatch('notif.laposte.fr'), 'Laposte');
    assert.strictEqual(nameFromMatch('jean@ex.com'), 'Ex');
    assert.strictEqual(nameFromMatch('@linkedin.com'), 'Linkedin');
    assert.strictEqual(nameFromMatch('localhost'), 'Localhost');
    assert.ok(nameFromMatch('a'.repeat(60) + '.com').length <= 40);

    const rules: MailRule[] = [
        rule({ from: 'promo.shop.com' }, 'promo', { hits: 3, lastHitAt: 50 }),
        rule({ from: 'news.org' }, 'newsletter'),
        rule({ from: 'osef.net' }, 'osef'),
        rule({ from: 'bot.io' }, 'notification'),
        // regex rule listed BEFORE its plain sender rule
        rule({ from: 'qonto.com', subject: 'relev[ée]' }, 'finance'),
        rule({ from: 'qonto.com' }, 'finance', { hits: 7, lastHitAt: 99 }),
        rule({ from: 'bank.fr' }, 'securite'),
        rule({ from: 'boss.com' }, 'action'),
        rule({ from: 'ex.com' }, 'lire', { createdAt: 5 }),
        rule({ from: 'ex.org' }, 'finance'),
        rule({ from: 'blocked.com' }, null),
        rule({ from: 'sig.com' }, 'newsletter', {
            origin: 'signal',
            confirmed: false,
        }),
        rule({ header: 'List-Id' }, 'newsletter'),
        rule({ from: 'maybe.com' }, 'action', { confirmed: false }),
    ];
    const { file, report } = migrateRulesToSenders(rules, 12345);

    assert.strictEqual(file.version, 3);
    assert.deepStrictEqual(
        file.spam.map((s) => s.match),
        ['promo.shop.com', 'news.org', 'osef.net', 'bot.io'],
    );
    assert.strictEqual(file.spam[0].hits, 3);
    assert.strictEqual(file.spam[0].lastHitAt, 50);
    assert.strictEqual(file.spam[0].createdAt, 1000);

    const byMatch = (m: string) => file.keep.find((k) => k.match === m)!;
    const q = byMatch('qonto.com');
    assert.strictEqual(q.name, 'Qonto');
    assert.strictEqual(q.read, 'rules');
    assert.strictEqual(q.readDefault, false);
    assert.deepStrictEqual(q.rules, [{ subject: 'relev[ée]', read: false }]);
    assert.strictEqual(q.hits, 7);
    assert.strictEqual(q.lastHitAt, 99);
    assert.strictEqual(byMatch('bank.fr').read, 'always');
    assert.strictEqual(byMatch('boss.com').read, 'always');
    assert.strictEqual(byMatch('ex.com').read, 'always');
    assert.strictEqual(byMatch('ex.com').createdAt, 5);
    assert.strictEqual(byMatch('ex.com').name, 'Ex');
    assert.strictEqual(byMatch('ex.org').name, 'Ex 2');
    assert.strictEqual(byMatch('ex.org').read, 'never');
    assert.ok(!file.keep.some((k) => k.match === 'blocked.com'));
    assert.ok(!file.keep.some((k) => k.match === 'maybe.com'));

    assert.strictEqual(report.at, 12345);
    assert.strictEqual(report.keep, 5);
    assert.strictEqual(report.spam, 4);
    assert.strictEqual(report.dropped, 2); // null + header-only
    assert.deepStrictEqual(report.unknown, [
        { match: 'sig.com', proposed: 'spam' },
    ]);
    assert.strictEqual(report.names.length, 5);
    assert.deepStrictEqual(report.names[0], {
        match: 'qonto.com',
        name: 'Qonto',
    });

    // always-mode sender gaining a subject rule keeps readDefault true
    const r2 = migrateRulesToSenders(
        [
            rule({ from: 'a.com' }, 'action'),
            rule({ from: 'a.com', subject: 'promo' }, 'promo'),
            rule({ from: 'a.com', subject: 'urgent' }, 'action'),
        ],
        1,
    );
    const a = r2.file.keep[0];
    assert.strictEqual(a.read, 'rules');
    assert.strictEqual(a.readDefault, true);
    assert.deepStrictEqual(a.rules, [
        { subject: 'promo', read: false },
        { subject: 'urgent', read: true },
    ]);

    // keep wins over spam, whatever the order
    const r3 = migrateRulesToSenders(
        [
            rule({ from: 'x.com' }, 'promo'),
            rule({ from: 'x.com' }, 'action'),
            rule({ from: 'y.com' }, 'action'),
            rule({ from: 'y.com' }, 'promo'),
            rule({ from: 'z.com' }, 'promo'),
            rule({ from: 'z.com', subject: 'rdv' }, 'action'),
            rule({ from: 'w.com', subject: 'deal' }, 'promo'),
            rule({ from: 'y.com', subject: 'deal' }, 'promo'),
        ],
        1,
    );
    assert.deepStrictEqual(r3.file.spam, []);
    assert.deepStrictEqual(r3.file.keep.map((k) => k.match).sort(), [
        'x.com',
        'y.com',
        'z.com',
    ]);
    assert.strictEqual(r3.report.dropped, 1);
    const y = r3.file.keep.find((k) => k.match === 'y.com')!;
    assert.deepStrictEqual(y.rules, [{ subject: 'deal', read: false }]);
    assert.strictEqual(y.readDefault, true);

    assert.strictEqual(
        nameFromMatch('trailmarguestaud@gmail.com'),
        'Trailmarguestaud',
    );
    assert.strictEqual(nameFromMatch('@gmail.com'), 'Gmail');
    assert.strictEqual(nameFromMatch('QONTO.COM'), 'Qonto');

    // readRulesFile : lecture tolérante, sans validation
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-migrate-'));
    const f = path.join(dir, 'mail-rules.json');
    assert.deepStrictEqual(readRulesFile(f), []); // absent
    fs.writeFileSync(f, '{oops');
    assert.deepStrictEqual(readRulesFile(f), []); // illisible
    fs.writeFileSync(f, JSON.stringify({ version: 1, rules: 'x' }));
    assert.deepStrictEqual(readRulesFile(f), []); // pas un tableau
    const good = rule({ from: 'a.com' }, 'promo');
    fs.writeFileSync(
        f,
        JSON.stringify({ version: 1, rules: [good, null, { id: 'z' }] }),
    );
    assert.deepStrictEqual(readRulesFile(f), [good]); // entrées informes jetées
    fs.rmSync(dir, { recursive: true, force: true });

    console.log('migrate: all tests passed');
}

run();
