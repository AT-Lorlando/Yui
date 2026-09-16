import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
    MailConcierge,
    applyRules,
    senderDomain,
    buildClassifyUser,
    parseClassifyReply,
    CATEGORY_LABELS,
} from './concierge';
import type { ConciergeRule } from '../types';

const tmp = () =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-conc-')), 't.json');

const MAILS_TEXT = [
    'ID: m1\nDe: Zalando <news@mail.zalando.fr>\nObjet: SOLDES -50%\nApercu: Profitez vite',
    'ID: m2\nDe: EDF <service@edf.fr>\nObjet: Votre facture est disponible\nApercu: Montant 84 EUR',
    'ID: m3\nDe: Marie <marie@gmail.com>\nObjet: Re: week-end\nApercu: On confirme samedi ?',
].join('\n---\n');

async function run(): Promise<void> {
    // ── Règles ────────────────────────────────────────────────────────────
    const rules: ConciergeRule[] = [{ match: 'zalando', category: 'promo' }];
    assert.strictEqual(
        applyRules(rules, 'Zalando <news@mail.zalando.fr>'),
        'promo',
    );
    assert.strictEqual(applyRules(rules, 'EDF <service@edf.fr>'), null);
    assert.strictEqual(
        applyRules([{ match: 'x', category: 'nawak' }], 'x@x.fr'),
        null,
        'catégorie inconnue ignorée',
    );
    assert.strictEqual(senderDomain('Marie <marie@gmail.com>'), 'gmail.com');

    // ── Prompt + parse ────────────────────────────────────────────────────
    const mails = [
        { id: 'a', from: 'X <x@y.fr>', subject: 'S1', snippet: 'sn1' },
        { id: 'b', from: 'Z <z@w.fr>', subject: 'S2', snippet: 'sn2' },
    ];
    const user = buildClassifyUser(mails);
    assert.ok(user.includes('1. De: X <x@y.fr>') && user.includes('S2'));
    assert.deepStrictEqual(
        parseClassifyReply(
            'ok: [{"i":1,"category":"promo"},{"i":2,"category":"action"}]',
            2,
        ),
        ['promo', 'action'],
    );
    assert.deepStrictEqual(
        parseClassifyReply('[{"i":1,"category":"lol"}]', 2),
        [null, null],
    );
    assert.deepStrictEqual(parseClassifyReply('rien', 1), [null]);

    // ── Scan : règle (auto) + LLM (proposition) + jamais reclassé ────────
    const calls: Array<{ tool: string; args: any }> = [];
    let learned: ConciergeRule[] = [{ match: 'zalando', category: 'promo' }];
    const concierge = new MailConcierge(
        {
            deviceHandler: async (tool, args) => {
                calls.push({ tool, args });
                if (tool === 'search_emails') return MAILS_TEXT;
                return 'ok';
            },
            complete: async (_sys, u) => {
                assert.ok(
                    u.includes('facture'),
                    'le lot LLM contient les non-réglés',
                );
                return '[{"i":1,"category":"admin"},{"i":2,"category":"lire"}]';
            },
            getRules: () => learned,
            addRule: (r) => {
                learned = [...learned.filter((x) => x.match !== r.match), r];
            },
            getAutoCategories: () => [],
            now: () => 1000,
        },
        tmp(),
    );

    const r1 = await concierge.scan();
    assert.strictEqual(r1.classified, 3);
    // Zalando (règle) appliqué direct : label + archive.
    const applied = calls.filter((c) => c.tool === 'modify_labels');
    assert.strictEqual(applied.length, 1, 'seule la règle est auto-appliquée');
    assert.strictEqual(applied[0]!.args.messageId, 'm1');
    assert.deepStrictEqual(applied[0]!.args.add, [CATEGORY_LABELS.promo]);
    assert.strictEqual(applied[0]!.args.archive, true);
    // EDF/Marie : propositions en attente.
    assert.strictEqual(concierge.pending().length, 2);

    // Re-scan : rien de nouveau (processedIds).
    const r2 = await concierge.scan();
    assert.strictEqual(r2.classified, 0);

    // ── Application groupée par catégorie ─────────────────────────────────
    const n = await concierge.apply({ category: 'admin' });
    assert.strictEqual(n, 1);
    assert.strictEqual(concierge.pending().length, 1);
    const adminApply = calls.filter((c) => c.tool === 'modify_labels').pop()!;
    assert.strictEqual(
        adminApply.args.archive,
        false,
        'admin ne s’archive pas',
    );

    // ── Correction : reclasse + apprend le domaine ────────────────────────
    const ok = await concierge.correct('m3', 'action');
    assert.ok(ok);
    assert.ok(
        learned.some((r) => r.match === 'gmail.com' && r.category === 'action'),
        'règle apprise sur le domaine',
    );
    assert.strictEqual(concierge.getState().stats.corrected, 1);

    console.log('All concierge tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
