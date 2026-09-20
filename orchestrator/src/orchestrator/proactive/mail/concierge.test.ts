import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
    MailConcierge,
    applyRules,
    senderDomain,
    extractBody,
    buildClassifySystem,
    buildClassifyUser,
    parseClassifyReply,
    allCategories,
    BASE_CATEGORIES,
} from './concierge';
import type { ConciergeRule, CustomCategory } from '../types';

const tmp = () =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-conc-')), 't.json');

const BASE_IDS = new Set(BASE_CATEGORIES.map((c) => c.id));

const MAILS_TEXT = [
    'ID: m1\nDe: Zalando <news@mail.zalando.fr>\nObjet: SOLDES -50%\nApercu: Profitez vite',
    'ID: m2\nDe: EDF <service@edf.fr>\nObjet: Votre facture est disponible\nApercu: Montant 84 EUR',
    'ID: m3\nDe: Plan Immobilier <alerte@plan-immobilier.fr>\nObjet: Nouveaux logements\nApercu: Alerte',
].join('\n---\n');

const BODIES: Record<string, string> = {
    m2: 'ID: m2\nDe: EDF\nObjet: Votre facture est disponible\n\n--- Corps ---\nBonjour,\n\n\nVotre facture de 84 EUR est disponible http://edf.fr/x   Merci.',
    m3: 'ID: m3\n--- Corps ---\nNouveaux logements neufs près de chez vous.',
};

async function run(): Promise<void> {
    // ── Catégories : base + perso, sans doublon ───────────────────────────
    const custom: CustomCategory[] = [
        {
            id: 'immo',
            label: 'Yui/Immobilier',
            description: 'Annonces immo',
            archive: true,
        },
        { id: 'promo', label: 'dup', description: 'ignoré (id de base)' },
    ];
    const cats = allCategories(custom);
    assert.strictEqual(cats.filter((c) => c.id === 'promo').length, 1);
    assert.ok(cats.find((c) => c.id === 'immo')?.custom);
    assert.ok(
        BASE_IDS.has('osef') &&
            BASE_IDS.has('finance') &&
            BASE_IDS.has('securite'),
    );

    // ── Règles ────────────────────────────────────────────────────────────
    const rules: ConciergeRule[] = [{ match: 'zalando', category: 'promo' }];
    assert.strictEqual(
        applyRules(rules, 'Zalando <news@mail.zalando.fr>', BASE_IDS),
        'promo',
    );
    assert.strictEqual(
        applyRules(rules, 'EDF <service@edf.fr>', BASE_IDS),
        null,
    );
    assert.strictEqual(
        applyRules([{ match: 'x', category: 'nawak' }], 'x@x.fr', BASE_IDS),
        null,
        'catégorie inconnue ignorée',
    );
    assert.strictEqual(senderDomain('Marie <marie@gmail.com>'), 'gmail.com');

    // ── Corps compacté ────────────────────────────────────────────────────
    const body = extractBody(BODIES.m2!);
    assert.ok(body.startsWith('Bonjour,'));
    assert.ok(body.includes('[lien]') && !body.includes('http://'));
    assert.ok(!body.includes('\n\n'), 'lignes vides compactées');
    assert.ok(extractBody('x'.repeat(2000)).length <= 702);

    // ── Prompts ───────────────────────────────────────────────────────────
    const system = buildClassifySystem(cats, [
        'Les alertes immobilières sont osef',
    ]);
    assert.ok(system.includes('"immo"') && system.includes('"osef"'));
    assert.ok(
        system.includes('RÈGLES DE JÉRÉMY') &&
            system.includes('alertes immobilières'),
    );
    assert.ok(!buildClassifySystem(cats).includes('RÈGLES DE JÉRÉMY'));
    const user = buildClassifyUser([
        {
            id: 'a',
            from: 'X <x@y.fr>',
            subject: 'S1',
            snippet: 'sn1',
            body: 'corps ici',
        },
        { id: 'b', from: 'Z <z@w.fr>', subject: 'S2', snippet: 'sn2' },
    ]);
    assert.ok(
        user.includes('Corps: corps ici') && user.includes('Aperçu: sn2'),
    );

    // ── Parse : catégories, doutes, suggestions filtrées ─────────────────
    const valid = new Set([...BASE_IDS, 'immo']);
    const parsed = parseClassifyReply(
        `ok: [
          {"i":1,"category":"promo"},
          {"i":2,"category":"lire","doubt":true,"reason":"pas sûr","alternatives":["lire","admin","zzz"],
           "suggestions":[{"kind":"rule","text":"Les factures EDF sont finance"},
                          {"kind":"category","id":"Éner gie!","label":"Yui/Énergie","text":"Fournisseurs d'énergie"},
                          {"kind":"category","id":"promo","text":"existe déjà"},
                          {"kind":"rule","text":""}]},
          {"i":3,"category":"lol"}
        ]`,
        3,
        valid,
    );
    assert.deepStrictEqual(parsed[0], { category: 'promo' });
    assert.strictEqual(parsed[1]?.category, 'lire');
    assert.deepStrictEqual(parsed[1]?.doubt?.alternatives, ['lire', 'admin']);
    assert.strictEqual(
        parsed[1]?.doubt?.suggestions.length,
        2,
        'catégorie existante + texte vide filtrés',
    );
    assert.strictEqual(parsed[1]?.doubt?.suggestions[1]?.id, 'nergie');
    assert.strictEqual(parsed[2], null);
    assert.deepStrictEqual(parseClassifyReply('rien', 1, valid), [null]);

    // ── Scan : règle (auto) + LLM avec corps + doute notifié ─────────────
    const calls: Array<{ tool: string; args: any }> = [];
    let learned: ConciergeRule[] = [{ match: 'zalando', category: 'promo' }];
    let promptRules: string[] = [];
    let customCats: CustomCategory[] = [];
    let notified: number[] = [];
    let seenSystem = '';
    const concierge = new MailConcierge(
        {
            deviceHandler: async (tool, args) => {
                calls.push({ tool, args });
                if (tool === 'search_emails') return MAILS_TEXT;
                if (tool === 'get_email')
                    return BODIES[args?.messageId as string] ?? '';
                return 'ok';
            },
            complete: async (sys, u) => {
                seenSystem = sys;
                assert.ok(u.includes('Corps: Bonjour,'), 'le corps est lu');
                assert.ok(!u.includes('zalando'), 'la règle a évité le LLM');
                return `[{"i":1,"category":"finance"},
                         {"i":2,"category":"promo","doubt":true,"reason":"alerte non sollicitée ?","alternatives":["promo","osef"],
                          "suggestions":[{"kind":"rule","text":"Les alertes Plan-Immobilier sont osef"},
                                         {"kind":"category","id":"immo","label":"Yui/Immobilier","text":"Alertes immobilières","archive":true}]}]`;
            },
            getRules: () => learned,
            addRule: (r) => {
                learned = [...learned.filter((x) => x.match !== r.match), r];
            },
            getAutoCategories: () => [],
            getPromptRules: () => promptRules,
            addPromptRule: (t) => void promptRules.push(t),
            getCustomCategories: () => customCats,
            addCustomCategory: (c) => void customCats.push(c),
            onDoubts: (d) => void notified.push(d.length),
            now: () => 1000,
        },
        tmp(),
    );

    const r1 = await concierge.scan();
    assert.deepStrictEqual(r1, { scanned: 3, classified: 3, doubts: 1 });
    assert.ok(seenSystem.includes('"osef"'));
    assert.strictEqual(
        calls.filter((c) => c.tool === 'get_email').length,
        2,
        'corps lus pour les non-réglés seulement',
    );
    const applied = calls.filter((c) => c.tool === 'modify_labels');
    assert.strictEqual(
        applied.length,
        1,
        'seule la règle est auto-appliquée (le doute jamais)',
    );
    assert.strictEqual(applied[0]!.args.messageId, 'm1');
    assert.deepStrictEqual(applied[0]!.args.add, ['Yui/Promos']);
    assert.strictEqual(applied[0]!.args.archive, true);
    assert.strictEqual(concierge.pending().length, 2);
    assert.strictEqual(concierge.openDoubts().length, 1);
    assert.deepStrictEqual(notified, [1], 'doute notifié une fois');

    // Re-scan : rien de nouveau.
    assert.strictEqual((await concierge.scan()).classified, 0);

    // ── Trancher le doute : catégorie + suggestions acceptées ────────────
    const doubt = concierge.openDoubts()[0]!;
    assert.ok(doubt.reason.includes('alerte'));
    const ok = await concierge.resolveDoubt(doubt.id, {
        category: 'osef',
        accept: [0, 1],
    });
    assert.ok(ok);
    assert.deepStrictEqual(promptRules, [
        'Les alertes Plan-Immobilier sont osef',
    ]);
    assert.strictEqual(customCats[0]?.id, 'immo');
    assert.ok(
        learned.some(
            (r) => r.match === 'plan-immobilier.fr' && r.category === 'osef',
        ),
        'règle expéditeur apprise',
    );
    assert.strictEqual(concierge.openDoubts().length, 0);
    const osefApply = calls.filter((c) => c.tool === 'modify_labels').pop()!;
    assert.deepStrictEqual(osefApply.args.add, ['Yui/Osef']);
    assert.strictEqual(osefApply.args.archive, true, 'osef archive');
    // La catégorie perso est désormais valide pour une correction.
    assert.ok(concierge.categories().some((c) => c.id === 'immo'));

    // ── Application groupée + correction classique ────────────────────────
    assert.strictEqual(await concierge.apply({ category: 'finance' }), 1);
    assert.strictEqual(concierge.pending().length, 0);
    assert.strictEqual(
        await concierge.correct('m2', 'nawak'),
        false,
        'catégorie inconnue refusée',
    );
    assert.strictEqual(concierge.getState().stats.corrected, 1);

    console.log('All concierge tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
