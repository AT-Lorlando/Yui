import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-rules-'));
const R = require('./rules') as typeof import('./rules');

const NOW = new Date('2026-09-28T09:00:00').getTime();
const mail = (
    over: Partial<import('./rules').RuleMail> = {},
): import('./rules').RuleMail => ({
    id: 'm1',
    from: '"Jérémy Dupont" <jeremy@gmail.com>',
    subject: 'Facture 42',
    headers: {},
    snippet: '',
    ...over,
});

async function run(): Promise<void> {
    // adresse / partie locale : le nom affiché ne compte jamais
    assert.strictEqual(
        R.senderAddress('"Jérémy Dupont" <Jeremy@Gmail.com>'),
        'jeremy@gmail.com',
    );
    assert.strictEqual(R.senderAddress('no-reply@x.io'), 'no-reply@x.io');
    assert.strictEqual(
        R.senderLocalPart('"No Reply" <No-Reply@x.io>'),
        'no-reply',
    );

    // matching : ET des conditions, insensible à la casse
    const r1 = R.newRule({
        when: { from: 'jeremy@gmail.com', subject: 'facture|invoice' },
        category: 'finance',
        origin: 'user',
        confirmed: true,
        now: NOW,
    });
    assert.ok(R.matchRule(r1, mail()));
    assert.ok(!R.matchRule(r1, mail({ subject: 'Bonjour' })));
    const rh = R.newRule({
        when: { header: 'List-Unsubscribe' },
        category: 'newsletter',
        origin: 'user',
        confirmed: true,
        now: NOW,
    });
    assert.ok(
        R.matchRule(
            rh,
            mail({ headers: { 'list-unsubscribe': '<mailto:x>' } }),
        ),
    ); // clé d'en-tête insensible à la casse
    assert.ok(!R.matchRule(rh, mail()));
    // regex invalide → jamais de match, pas d'exception
    const bad = R.newRule({
        when: { subject: '(' },
        category: 'osef',
        origin: 'user',
        confirmed: true,
        now: NOW,
    });
    assert.strictEqual(R.matchRule(bad, mail()), false);

    // ordre : user avant correction avant signal, puis la plus ancienne
    const sig = R.ruleFromSignal(mail().from, 'notification', NOW - 10);
    const corr = R.ruleFromCorrection(mail().from, 'perso', NOW - 5);
    const sorted = R.sortRules([sig, corr, r1]);
    assert.deepStrictEqual(
        sorted.map((r) => r.origin),
        ['user', 'correction', 'signal'],
    );
    assert.strictEqual(R.firstMatch([sig, corr, r1], mail())?.id, r1.id);
    assert.strictEqual(R.ruleFor([sig, corr], mail().from)?.id, sig.id); // when.from = adresse exacte
    assert.strictEqual(sig.confirmed, false);
    assert.strictEqual(corr.when.from, 'gmail.com');

    // validation d'une règle saisie
    const valid = new Set(['finance', 'osef']);
    assert.strictEqual(
        R.validateRuleInput({ when: {}, then: { category: 'finance' } }, valid)
            .ok,
        false,
    );
    assert.strictEqual(
        R.validateRuleInput(
            { when: { from: 'x' }, then: { category: 'nope' } },
            valid,
        ).ok,
        false,
    );
    assert.strictEqual(
        R.validateRuleInput(
            { when: { subject: '(' }, then: { category: 'osef' } },
            valid,
        ).ok,
        false,
    );
    const publicDomain = R.validateRuleInput(
        { when: { from: 'gmail.com' }, then: { category: 'osef' } },
        valid,
    );
    assert.ok(
        !publicDomain.ok &&
            publicDomain.error ===
                "domaine grand public : précise l'adresse complète",
    );
    assert.ok(
        R.validateRuleInput(
            { when: { from: 'x@gmail.com' }, then: { category: 'osef' } },
            valid,
        ).ok,
    );
    assert.ok(
        R.validateRuleInput(
            { when: { from: 'zalando.fr' }, then: { category: 'osef' } },
            valid,
        ).ok,
    );
    const okNeg = R.validateRuleInput(
        { when: { from: 'x@y.z' }, then: { category: null } },
        valid,
    );
    assert.ok(
        okNeg.ok &&
            okNeg.rule.then.category === null &&
            okNeg.rule.origin === 'user' &&
            okNeg.rule.confirmed,
    );

    // migration legacy
    const migrated = R.migrateLegacyRules(
        [{ match: 'zalando', category: 'promo' }],
        NOW,
    );
    assert.deepStrictEqual(migrated[0]!.when, { from: 'zalando' });
    assert.strictEqual(migrated[0]!.origin, 'correction');
    assert.strictEqual(migrated[0]!.confirmed, true);

    // store : persistance, upsert par id, hits
    const file = path.join(process.env.YUI_DATA_DIR!, 'r.json');
    const store = new R.RuleStore(file);
    assert.strictEqual(store.exists(), false);
    store.upsert(r1);
    store.recordHit(r1.id, NOW);
    const again = new R.RuleStore(file);
    assert.strictEqual(again.exists(), true);
    assert.strictEqual(again.all()[0]!.hits, 1);
    assert.strictEqual(again.all()[0]!.lastHitAt, NOW);
    again.upsert({ ...r1, then: { category: 'osef' } });
    assert.strictEqual(again.all().length, 1);
    assert.strictEqual(again.remove('nope'), false);
    assert.strictEqual(again.remove(r1.id), true);
    assert.strictEqual(new R.RuleStore(file).all().length, 0);

    // écriture best-effort : parent = fichier (impossible à mkdir dedans) →
    // upsert() ne plante pas, la règle reste au moins en mémoire
    const blockerDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'yui-rules-blocked-'),
    );
    const blockerFile = path.join(blockerDir, 'x');
    fs.writeFileSync(blockerFile, 'not a directory');
    const blocked = new R.RuleStore(path.join(blockerFile, 'rules.json'));
    assert.doesNotThrow(() => blocked.upsert(r1));
    assert.strictEqual(blocked.all().length, 1);

    // replaceAll : remplace tout le fichier (édition JSON brut) — même une
    // règle non confirmée peut en sortir, c'est le but de l'édition brute
    const replFile = path.join(process.env.YUI_DATA_DIR!, 'repl.json');
    const replStore = new R.RuleStore(replFile);
    replStore.upsert(r1);
    replStore.upsert(sig);
    replStore.replaceAll([corr]);
    assert.deepStrictEqual(
        new R.RuleStore(replFile).all().map((r) => r.id),
        [corr.id],
    );

    // migration une seule fois : store absent → écrit, puis idempotent
    const migFile = path.join(process.env.YUI_DATA_DIR!, 'mig.json');
    const migStore = new R.RuleStore(migFile);
    assert.strictEqual(migStore.exists(), false);
    const n1 = R.migrateRulesOnce(
        migStore,
        [{ match: 'zalando', category: 'promo' }],
        NOW,
    );
    assert.strictEqual(n1, 1);
    assert.strictEqual(migStore.exists(), true);
    const n2 = R.migrateRulesOnce(
        migStore,
        [{ match: 'zalando', category: 'promo' }],
        NOW,
    );
    assert.strictEqual(n2, 0);

    console.log('rules ok');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
