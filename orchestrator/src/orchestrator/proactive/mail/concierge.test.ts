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
    parseMetaList,
    loadTriage,
    saveTriage,
    allCategories,
    BASE_CATEGORIES,
} from './concierge';
import type { ConciergeDeps } from './concierge';
import { RuleStore, newRule } from './rules';
import { MailJournal } from './journal';
import type { ConciergeRule, CustomCategory } from '../types';

const tmp = () =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-conc-')), 't.json');

const BASE_IDS = new Set(BASE_CATEGORIES.map((c) => c.id));

// Forme réelle de list_messages_meta (déjà parsée par le moteur).
const META = [
    {
        id: 'm1',
        threadId: 't1',
        from: 'Zalando <news@mail.zalando.fr>',
        subject: 'SOLDES -50%',
        snippet: 'Profitez vite',
        headers: { 'List-Unsubscribe': '<x>' },
        labelIds: ['INBOX'],
    },
    {
        id: 'm2',
        threadId: 't2',
        from: 'EDF <service@edf.fr>',
        subject: 'Votre facture est disponible',
        snippet: 'Montant 84 EUR',
        headers: {},
        labelIds: ['INBOX'],
    },
    {
        id: 'm3',
        threadId: 't3',
        from: 'Plan Immobilier <alerte@plan-immobilier.fr>',
        subject: 'Nouveaux logements',
        snippet: 'Alerte',
        headers: {},
        labelIds: ['INBOX'],
    },
];

const BODIES: Record<string, string> = {
    m2: 'ID: m2\nDe: EDF\nObjet: Votre facture est disponible\n\n--- Corps ---\nBonjour,\n\n\nVotre facture de 84 EUR est disponible http://edf.fr/x   Merci.',
    m3: 'ID: m3\n--- Corps ---\nNouveaux logements neufs près de chez vous.',
};

const unknownMail = (i: number) => ({
    id: `u${i}`,
    threadId: `tu${i}`,
    from: `Inconnu ${i} <contact${i}@inconnu-${i}.fr>`,
    subject: `Sujet ${i}`,
    snippet: `aperçu ${i}`,
    headers: {},
    labelIds: ['INBOX'],
});

/** Concierge de test : boîte mutable, appels enregistrés, LLM injectable. */
function makeConcierge(opts: {
    inbox: () => unknown[];
    complete: ConciergeDeps['complete'];
    rules?: RuleStore;
    journal?: MailJournal;
    readBodies?: boolean;
    now?: () => number;
    extra?: Partial<ConciergeDeps>;
}) {
    const calls: Array<{ tool: string; args: any }> = [];
    const rules = opts.rules ?? new RuleStore(tmp());
    const journal = opts.journal ?? new MailJournal(tmp());
    const concierge = new MailConcierge(
        {
            deviceHandler: async (tool, args) => {
                calls.push({ tool, args });
                if (tool === 'list_messages_meta') return opts.inbox();
                if (tool === 'get_email')
                    return BODIES[args?.messageId as string] ?? '';
                return 'ok';
            },
            complete: opts.complete,
            rules,
            journal,
            getAutoCategories: () => [],
            readBodies: opts.readBodies,
            now: opts.now ?? (() => 1000),
            ...opts.extra,
        },
        tmp(),
    );
    return { concierge, calls, rules, journal };
}

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

    // ── Règles legacy (helper pur conservé) ──────────────────────────────
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
    assert.deepStrictEqual(parsed[0], {
        category: 'promo',
        urgency: 'none',
        reason: '',
    });
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
    // Urgence et raison : toujours présentes, défaut "none" / "" (jamais absentes).
    assert.deepStrictEqual(
        parseClassifyReply(
            '[{"i":1,"category":"action","urgency":"now","reason":"Échéance demain"}]',
            1,
            valid,
        )[0],
        { category: 'action', urgency: 'now', reason: 'Échéance demain' },
    );
    const withUrgency = parseClassifyReply(
        '[{"i":1,"category":"action","reason":"échéance demain"},{"i":2,"category":"lire","urgency":"nawak"}]',
        2,
        valid,
    );
    assert.strictEqual(withUrgency[0]?.urgency, 'none', 'absente → none');
    assert.strictEqual(withUrgency[0]?.reason, 'échéance demain');
    assert.strictEqual(
        withUrgency[1]?.urgency,
        'none',
        'valeur inconnue → none',
    );
    assert.strictEqual(withUrgency[1]?.reason, '');
    assert.ok(
        buildClassifySystem(cats).includes('"now" est RARE'),
        'le prompt met en garde contre le surclassement en urgence',
    );
    // Vécu (01/10) : des alertes de sécurité automatiques classées "now" →
    // « piratage en cours » parlé par le juge. Le prompt les range en notifications.
    assert.ok(
        /alertes de sécurité automatiques[^.]*jamais "now"/.test(
            buildClassifySystem(cats),
        ),
        'les alertes de sécurité automatiques ne sont jamais "now"',
    );

    // ── list_messages_meta : tableau, JSON texte, ou rien ────────────────
    assert.strictEqual(parseMetaList(META).length, 3);
    assert.strictEqual(parseMetaList(JSON.stringify(META)).length, 3);
    assert.deepStrictEqual(parseMetaList('pas du json'), []);
    assert.deepStrictEqual(parseMetaList(null), []);
    assert.deepStrictEqual(parseMetaList([{ from: 'sans id' }]), []);
    const meta = parseMetaList([{ id: 'x', from: 'a@b.c' }])[0]!;
    assert.deepStrictEqual(meta.headers, {});
    assert.deepStrictEqual(meta.labelIds, []);
    assert.strictEqual(meta.subject, '');

    // ── État : fallbackTries absent du fichier → {} ; persisté ensuite ──
    const stFile = tmp();
    fs.writeFileSync(
        stFile,
        JSON.stringify({ proposals: [], doubts: [], processedIds: [] }),
    );
    const loaded = loadTriage(stFile);
    assert.deepStrictEqual(loaded.fallbackTries, {});
    loaded.fallbackTries.z = 2;
    saveTriage(loaded, stFile);
    assert.deepStrictEqual(loadTriage(stFile).fallbackTries, { z: 2 });

    // ── Scan : signal (quarantaine) + LLM avec corps + doute notifié ─────
    let inbox: unknown[] = [...META];
    let promptRules: string[] = [];
    let customCats: CustomCategory[] = [];
    let notified: number[] = [];
    let seenSystem = '';
    let completes = 0;
    const main = makeConcierge({
        inbox: () => inbox,
        complete: async (sys, u) => {
            completes++;
            seenSystem = sys;
            assert.ok(u.includes('Corps: Bonjour,'), 'le corps est lu');
            assert.ok(!u.includes('zalando'), 'le signal a évité le LLM');
            return `[{"i":1,"category":"finance"},
                     {"i":2,"category":"promo","doubt":true,"reason":"alerte non sollicitée ?","alternatives":["promo","osef"],
                      "suggestions":[{"kind":"rule","text":"Les alertes Plan-Immobilier sont osef"},
                                     {"kind":"category","id":"immo","label":"Yui/Immobilier","text":"Alertes immobilières","archive":true}]}]`;
        },
        extra: {
            getPromptRules: () => promptRules,
            addPromptRule: (t) => void promptRules.push(t),
            getCustomCategories: () => customCats,
            addCustomCategory: (c) => void customCats.push(c),
            onDoubts: (d) => void notified.push(d.length),
        },
    });
    const { concierge, calls, rules: store, journal } = main;

    const r1 = await concierge.scan();
    assert.deepStrictEqual(r1, { scanned: 3, classified: 3, doubts: 1 });
    assert.strictEqual(completes, 1, 'un seul lot LLM (m2, m3)');
    assert.ok(seenSystem.includes('"osef"'));
    assert.strictEqual(
        calls.filter((c) => c.tool === 'get_email').length,
        2,
        'corps lus pour les candidats LLM seulement',
    );
    const applied = calls.filter((c) => c.tool === 'modify_labels');
    assert.strictEqual(
        applied.length,
        1,
        'seul le signal pose un label (le doute jamais)',
    );
    assert.strictEqual(applied[0]!.args.messageId, 'm1');
    assert.deepStrictEqual(applied[0]!.args.add, ['Yui/Newsletters']);
    assert.ok(
        !('archive' in applied[0]!.args),
        'un signal pose le label seul, jamais d’archive',
    );
    const st = concierge.getState();
    const p1 = st.proposals.find((p) => p.mailId === 'm1')!;
    assert.strictEqual(p1.via, 'signal');
    assert.strictEqual(p1.stage, 'signal');
    assert.strictEqual(p1.category, 'newsletter');
    assert.strictEqual(p1.proposeArchive, false);
    assert.strictEqual(p1.auto, true);
    assert.ok(p1.appliedAt && p1.ruleId);
    assert.ok(st.processedIds.includes('m1'));
    const q1 = store.all().find((r) => r.id === p1.ruleId)!;
    assert.strictEqual(q1.origin, 'signal');
    assert.strictEqual(q1.confirmed, false);
    assert.strictEqual(q1.when.from, 'news@mail.zalando.fr');
    assert.strictEqual(q1.then.category, 'newsletter');
    assert.strictEqual(q1.hits, 1);
    const p2 = st.proposals.find((p) => p.mailId === 'm2')!;
    assert.strictEqual(p2.via, 'llm');
    assert.strictEqual(p2.stage, 'llm');
    assert.strictEqual(p2.urgency, 'none');
    assert.strictEqual(p2.reason, '');
    assert.strictEqual(concierge.pending().length, 2);
    assert.strictEqual(concierge.openDoubts().length, 1);
    assert.deepStrictEqual(notified, [1], 'doute notifié une fois');
    assert.strictEqual(journal.size(), 3, 'une décision par mail conclu');
    const j1 = journal.list().find((d) => d.mailId === 'm1')!;
    assert.strictEqual(j1.stage, 'signal');
    assert.strictEqual(j1.signal, 'list-unsubscribe');
    assert.strictEqual(j1.ruleId, p1.ruleId);
    assert.strictEqual(j1.applied, true);
    assert.strictEqual(
        journal.list().find((d) => d.mailId === 'm2')!.applied,
        false,
    );

    // Re-scan : rien de nouveau.
    assert.strictEqual((await concierge.scan()).classified, 0);

    // Nouveau mail du même expéditeur : la règle de quarantaine encaisse
    // (hits 2), label seul, pas de LLM.
    inbox = [
        ...META,
        {
            id: 'm4',
            from: 'Zalando <news@mail.zalando.fr>',
            subject: 'Nouveautés automne',
            snippet: '…',
            headers: {},
            labelIds: ['INBOX'],
        },
    ];
    const r2 = await concierge.scan();
    assert.strictEqual(r2.classified, 1);
    assert.strictEqual(completes, 1, 'pas de LLM pour un expéditeur connu');
    assert.strictEqual(store.all().find((r) => r.id === p1.ruleId)!.hits, 2);
    const m4 = calls.filter((c) => c.tool === 'modify_labels').pop()!;
    assert.strictEqual(m4.args.messageId, 'm4');
    assert.ok(!('archive' in m4.args));
    const p4 = st.proposals.find((p) => p.mailId === 'm4')!;
    assert.strictEqual(p4.stage, 'signal');
    assert.strictEqual(p4.ruleId, p1.ruleId);

    // ── rules() / quarantine() ───────────────────────────────────────────
    assert.strictEqual(concierge.rules().length, 1);
    const quarantine = concierge.quarantine();
    assert.strictEqual(quarantine.length, 1);
    assert.deepStrictEqual(quarantine[0], {
        ruleId: p1.ruleId,
        from: 'news@mail.zalando.fr',
        category: 'newsletter',
        hits: 2,
        lastHitAt: 1000,
        lastSubject: 'Nouveautés automne',
    });

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
    const learnedRule = store
        .all()
        .find(
            (r) =>
                r.when.from === 'plan-immobilier.fr' &&
                r.then.category === 'osef',
        );
    assert.ok(learnedRule, 'règle expéditeur apprise (domaine)');
    assert.strictEqual(learnedRule!.origin, 'correction');
    assert.strictEqual(learnedRule!.confirmed, true);
    assert.strictEqual(concierge.openDoubts().length, 0);
    const osefApply = calls.filter((c) => c.tool === 'modify_labels').pop()!;
    assert.deepStrictEqual(osefApply.args.add, ['Yui/Osef']);
    assert.strictEqual(osefApply.args.archive, true, 'osef archive');
    // La catégorie perso est désormais valide pour une correction.
    assert.ok(concierge.categories().some((c) => c.id === 'immo'));
    assert.strictEqual(concierge.rules()[0]!.origin, 'correction', 'triées');

    // ── Correction d'un expéditeur en quarantaine : même id, confirmée ──
    assert.ok(await concierge.correct('m1', 'perso'));
    const promoted = store.all().find((r) => r.id === p1.ruleId)!;
    assert.strictEqual(promoted.origin, 'correction');
    assert.strictEqual(promoted.confirmed, true);
    assert.strictEqual(promoted.then.category, 'perso');
    assert.strictEqual(promoted.when.from, 'news@mail.zalando.fr');
    assert.strictEqual(concierge.quarantine().length, 0);
    const fix = calls.filter((c) => c.tool === 'modify_labels').pop()!;
    assert.deepStrictEqual(fix.args.add, ['Yui/Perso']);
    assert.deepStrictEqual(fix.args.remove, ['Yui/Newsletters']);
    // Une seconde correction sur le même domaine remplace la règle (jamais
    // deux règles concurrentes dont la plus ancienne gagnerait toujours).
    assert.ok(await concierge.correct('m3', 'immo'));
    const immoRules = store
        .all()
        .filter((r) => r.when.from === 'plan-immobilier.fr');
    assert.strictEqual(immoRules.length, 1);
    assert.strictEqual(immoRules[0]!.id, learnedRule!.id);
    assert.strictEqual(immoRules[0]!.then.category, 'immo');

    // ── Application groupée + correction classique ────────────────────────
    assert.strictEqual(await concierge.apply({ category: 'finance' }), 1);
    assert.strictEqual(concierge.pending().length, 0);
    assert.strictEqual(
        await concierge.correct('m2', 'nawak'),
        false,
        'catégorie inconnue refusée',
    );
    assert.strictEqual(concierge.getState().stats.corrected, 3);

    // ── Règle utilisateur confirmée : application directe (étage 1) ──────
    {
        const rs = new RuleStore(tmp());
        rs.upsert(
            newRule({
                when: { from: 'edf.fr' },
                category: 'admin',
                origin: 'user',
                confirmed: true,
                now: 500,
            }),
        );
        const edfRule = rs.all()[0]!;
        let n = 0;
        const t = makeConcierge({
            inbox: () => [META[1]],
            complete: async () => {
                n++;
                return '[]';
            },
            rules: rs,
        });
        const r = await t.concierge.scan();
        assert.deepStrictEqual(r, { scanned: 1, classified: 1, doubts: 0 });
        assert.strictEqual(n, 0, 'aucun appel LLM');
        const lab = t.calls.find((c) => c.tool === 'modify_labels')!;
        assert.deepStrictEqual(lab.args.add, ['Yui/Admin']);
        assert.strictEqual(lab.args.archive, false);
        const p = t.concierge.getState().proposals[0]!;
        assert.strictEqual(p.via, 'rule');
        assert.strictEqual(p.stage, 'rule');
        assert.strictEqual(p.ruleId, edfRule.id);
        assert.strictEqual(p.auto, true);
        assert.ok(p.appliedAt);
        assert.strictEqual(rs.all()[0]!.hits, 1);
        const d = t.journal.list()[0]!;
        assert.strictEqual(d.stage, 'rule');
        assert.strictEqual(d.ruleId, edfRule.id);
        assert.strictEqual(d.applied, true);
        assert.ok(t.concierge.getState().processedIds.includes('m2'));
    }

    // ── Règle utilisateur confirmée sur une catégorie d'archivage : l'étage
    // règle applique aussi l'archive (pas seulement le label) ─────────────
    {
        const rs = new RuleStore(tmp());
        rs.upsert(
            newRule({
                when: { from: 'zalando.fr' },
                category: 'newsletter',
                origin: 'user',
                confirmed: true,
                now: 500,
            }),
        );
        const t = makeConcierge({
            inbox: () => [META[0]],
            complete: async () => {
                throw new Error('pas de LLM attendu');
            },
            rules: rs,
        });
        const r = await t.concierge.scan();
        assert.deepStrictEqual(r, { scanned: 1, classified: 1, doubts: 0 });
        const lab = t.calls.find((c) => c.tool === 'modify_labels')!;
        assert.deepStrictEqual(lab.args.add, ['Yui/Newsletters']);
        assert.strictEqual(lab.args.archive, true, 'catégorie archivante');
        const p = t.concierge.getState().proposals[0]!;
        assert.strictEqual(p.via, 'rule');
        assert.strictEqual(p.proposeArchive, true);
    }

    // ── onCorrected : appelé après la correction avec l'ancienne et la
    // nouvelle catégorie ───────────────────────────────────────────────────
    {
        const corrections: Array<[string, string, string]> = [];
        const t = makeConcierge({
            inbox: () => [META[1]],
            complete: async () => '[{"i":1,"category":"finance"}]',
            extra: {
                onCorrected: (id, prev, next) =>
                    void corrections.push([id, prev, next]),
            },
        });
        await t.concierge.scan();
        assert.ok(await t.concierge.correct('m2', 'admin'));
        assert.deepStrictEqual(corrections, [['m2', 'finance', 'admin']]);
    }

    // ── fallbackTries : plafonné à 200 entrées à la sauvegarde (les plus
    // anciennes sautent, jamais les plus récentes) ────────────────────────
    {
        const st = loadTriage(tmp());
        for (let i = 0; i < 205; i++) st.fallbackTries[`m${i}`] = 1;
        const file = tmp();
        saveTriage(st, file);
        const reloaded = loadTriage(file);
        assert.strictEqual(Object.keys(reloaded.fallbackTries).length, 200);
        assert.ok(!('m0' in reloaded.fallbackTries), 'plus ancienne écartée');
        assert.ok('m204' in reloaded.fallbackTries, 'plus récente conservée');
    }

    // ── 60 inconnus : 24 par sondage (2 lots de 12), le reste attend ────
    {
        const sixty = Array.from({ length: 60 }, (_, i) => unknownMail(i));
        let n = 0;
        const t = makeConcierge({
            inbox: () => sixty,
            readBodies: false,
            complete: async (_s, u) => {
                n++;
                const count = (u.match(/^\d+\. De:/gm) ?? []).length;
                assert.strictEqual(count, 12, 'lots de 12');
                return JSON.stringify(
                    Array.from({ length: count }, (_, i) => ({
                        i: i + 1,
                        category: 'lire',
                    })),
                );
            },
        });
        const r = await t.concierge.scan('in:inbox', 100);
        assert.strictEqual(n, 2);
        assert.strictEqual(r.classified, 24);
        const s = t.concierge.getState();
        assert.strictEqual(s.processedIds.length, 24);
        assert.strictEqual(s.proposals.length, 24);
        assert.ok(!s.processedIds.includes('u24'));
        assert.ok(!s.proposals.some((p) => p.mailId === 'u59'));
        assert.strictEqual(t.journal.size(), 24);
        // Le sondage suivant reprend les reportés.
        await t.concierge.scan('in:inbox', 100);
        assert.strictEqual(n, 4);
        assert.strictEqual(t.concierge.getState().processedIds.length, 48);
        assert.ok(t.concierge.getState().processedIds.includes('u24'));
    }

    // ── LLM en panne : retenté 3 fois, puis repli « lire » ───────────────
    {
        const t = makeConcierge({
            inbox: () => [META[1]],
            readBodies: false,
            complete: async () => {
                throw new Error('LLM down');
            },
        });
        await t.concierge.scan();
        let s = t.concierge.getState();
        assert.deepStrictEqual(s.processedIds, []);
        assert.strictEqual(s.proposals.length, 0);
        assert.deepStrictEqual(s.fallbackTries, { m2: 1 });
        assert.strictEqual(
            t.journal.size(),
            0,
            'un retry ne se journalise pas',
        );
        await t.concierge.scan();
        assert.deepStrictEqual(t.concierge.getState().fallbackTries, { m2: 2 });
        assert.strictEqual(
            t.calls.filter((c) => c.tool === 'modify_labels').length,
            0,
        );
        const r3 = await t.concierge.scan();
        assert.strictEqual(r3.classified, 1);
        s = t.concierge.getState();
        assert.deepStrictEqual(s.fallbackTries, {});
        assert.deepStrictEqual(s.processedIds, ['m2']);
        const p = s.proposals[0]!;
        assert.strictEqual(p.category, 'lire');
        assert.strictEqual(p.via, 'fallback');
        assert.strictEqual(p.stage, 'fallback');
        assert.strictEqual(p.proposeArchive, false);
        assert.ok(p.appliedAt);
        const lab = t.calls.filter((c) => c.tool === 'modify_labels');
        assert.strictEqual(lab.length, 1);
        assert.deepStrictEqual(lab[0]!.args.add, ['Yui/A lire']);
        assert.ok(!('archive' in lab[0]!.args));
        const d = t.journal.list()[0]!;
        assert.strictEqual(d.stage, 'fallback');
        assert.strictEqual(d.applied, true);
        assert.strictEqual(t.journal.size(), 1);
    }

    // ── Item illisible dans un lot : même repli ; un succès efface le compteur
    {
        let n = 0;
        const t = makeConcierge({
            inbox: () => [META[1], META[2]],
            readBodies: false,
            complete: async () => {
                n++;
                return n === 1
                    ? '[{"i":1,"category":"finance"}]'
                    : '[{"i":1,"category":"lire"}]';
            },
        });
        await t.concierge.scan();
        let s = t.concierge.getState();
        assert.deepStrictEqual(s.processedIds, ['m2']);
        assert.deepStrictEqual(s.fallbackTries, { m3: 1 });
        await t.concierge.scan();
        s = t.concierge.getState();
        assert.deepStrictEqual(s.processedIds, ['m2', 'm3']);
        assert.deepStrictEqual(s.fallbackTries, {});
        assert.strictEqual(
            s.proposals.find((p) => p.mailId === 'm3')!.via,
            'llm',
        );
    }

    // ── Quarantaine : confirmer (archive rétroactive plafonnée à 100) ─────
    {
        const rs = new RuleStore(tmp());
        const quarantineRule = newRule({
            when: { from: 'news@mail.zalando.fr' },
            category: 'newsletter',
            origin: 'signal',
            confirmed: false,
            now: 500,
        });
        rs.upsert(quarantineRule);
        const t = makeConcierge({
            inbox: () => [
                {
                    id: 'z1',
                    from: 'news@mail.zalando.fr',
                    subject: 'S',
                    snippet: '',
                    headers: {},
                    labelIds: ['INBOX'],
                },
            ],
            complete: async () => '[]',
            rules: rs,
        });
        const ok = await t.concierge.quarantineAct(
            quarantineRule.id,
            'confirm',
        );
        assert.ok(ok);
        assert.strictEqual(
            rs.all().find((r) => r.id === quarantineRule.id)!.confirmed,
            true,
        );
        const archived = t.calls.filter(
            (c) => c.tool === 'modify_labels' && c.args.archive === true,
        );
        assert.strictEqual(archived.length, 1);
        assert.strictEqual(archived[0]!.args.messageId, 'z1');
        const listCall = t.calls.find((c) => c.tool === 'list_messages_meta')!;
        assert.strictEqual(
            listCall.args.query,
            'from:news@mail.zalando.fr label:"Yui/Newsletters" in:inbox',
        );
        assert.strictEqual(listCall.args.maxResults, 100);
        const journalEntry = t.journal.list()[0]!;
        assert.strictEqual(journalEntry.reason, 'quarantaine : confirm');
        assert.strictEqual(journalEntry.stage, 'rule');
        assert.strictEqual(journalEntry.applied, true);
        assert.strictEqual(journalEntry.mailId, '');
        assert.strictEqual(journalEntry.subject, '');
        assert.strictEqual(journalEntry.from, 'news@mail.zalando.fr');
        // Confirmer une règle inconnue échoue.
        assert.strictEqual(
            await t.concierge.quarantineAct('inconnue', 'confirm'),
            false,
        );
    }

    // ── Quarantaine : seules les règles de quarantaine réelles (signal, pas
    // encore confirmées) sont décidables ici — une règle utilisateur ou déjà
    // confirmée doit être ignorée, jamais supprimée ni réarchivée ───────────
    {
        const rs = new RuleStore(tmp());
        const userRule = newRule({
            when: { from: 'z@z.fr' },
            category: 'action',
            origin: 'user',
            confirmed: true,
            now: 10,
        });
        rs.upsert(userRule);
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            rules: rs,
        });
        assert.strictEqual(
            await t.concierge.quarantineAct(userRule.id, 'reject'),
            false,
        );
        assert.deepStrictEqual(
            rs.all(),
            [userRule],
            'règle utilisateur intacte',
        );
        assert.strictEqual(
            t.calls.filter((c) => c.tool === 'modify_labels').length,
            0,
            'aucun relabel sur une règle qui n’est pas en quarantaine',
        );

        const correctionRule = newRule({
            when: { from: 'c@c.fr' },
            category: 'newsletter',
            origin: 'correction',
            confirmed: true,
            now: 10,
        });
        rs.upsert(correctionRule);
        assert.strictEqual(
            await t.concierge.quarantineAct(correctionRule.id, 'confirm'),
            false,
            'déjà confirmée : rien à réentériner',
        );
        assert.strictEqual(
            t.calls.filter((c) => c.tool === 'modify_labels').length,
            0,
            'pas de réarchivage',
        );
    }

    // ── Quarantaine : corriger (relabel + proposition mise à jour) ────────
    {
        const rs = new RuleStore(tmp());
        const rule = newRule({
            when: { from: 'x@y.fr' },
            category: 'newsletter',
            origin: 'signal',
            confirmed: false,
            now: 500,
        });
        rs.upsert(rule);
        const t = makeConcierge({
            inbox: () => [
                {
                    id: 'z2',
                    from: 'x@y.fr',
                    subject: 'S',
                    snippet: '',
                    headers: {},
                    labelIds: [],
                },
            ],
            complete: async () => '[]',
            rules: rs,
        });
        t.concierge.getState().proposals.push({
            mailId: 'z2',
            from: 'x@y.fr',
            subject: 'S',
            category: 'newsletter',
            via: 'signal',
            stage: 'signal',
            ruleId: rule.id,
            proposeArchive: false,
        });
        // Catégorie manquante : refusée avant tout effet (false, pas d'erreur).
        assert.strictEqual(
            await t.concierge.quarantineAct(rule.id, 'correct', {}),
            false,
        );
        // Catégorie fournie mais inconnue : la route doit pouvoir la
        // distinguer d'une règle absente (400, pas 404) — signalée par une
        // exception plutôt qu'un simple `false`.
        await assert.rejects(
            () =>
                t.concierge.quarantineAct(rule.id, 'correct', {
                    category: 'nawak',
                }),
            /catégorie inconnue/,
        );
        assert.strictEqual(
            t.calls.filter((c) => c.tool === 'modify_labels').length,
            0,
            'aucun effet tant que la catégorie n’est pas valide',
        );
        const ok = await t.concierge.quarantineAct(rule.id, 'correct', {
            category: 'admin',
        });
        assert.ok(ok);
        const updated = rs.all().find((r) => r.id === rule.id)!;
        assert.strictEqual(updated.then.category, 'admin');
        assert.strictEqual(updated.origin, 'correction');
        assert.strictEqual(updated.confirmed, true);
        const relabel = t.calls.find((c) => c.tool === 'modify_labels')!;
        assert.deepStrictEqual(relabel.args.add, ['Yui/Admin']);
        assert.deepStrictEqual(relabel.args.remove, ['Yui/Newsletters']);
        assert.strictEqual(relabel.args.archive, false);
        const listCall = t.calls.find((c) => c.tool === 'list_messages_meta')!;
        assert.strictEqual(
            listCall.args.query,
            'from:x@y.fr label:"Yui/Newsletters"',
        );
        const prop = t.concierge
            .getState()
            .proposals.find((p) => p.mailId === 'z2')!;
        assert.strictEqual(prop.category, 'admin');
        assert.strictEqual(prop.proposeArchive, false);
    }

    // ── Quarantaine : rejeter — règle négative, label retiré, le signal ne
    // conclut plus (Focus 5 : le mail suivant du même expéditeur va au LLM) ─
    {
        const rs = new RuleStore(tmp());
        const rule = newRule({
            when: { from: 'promo@shop.fr' },
            category: 'newsletter',
            origin: 'signal',
            confirmed: false,
            now: 500,
        });
        rs.upsert(rule);
        const t = makeConcierge({
            inbox: () => [
                {
                    id: 'z3',
                    from: 'promo@shop.fr',
                    subject: 'S',
                    snippet: '',
                    headers: {},
                    labelIds: [],
                },
            ],
            complete: async () => '[{"i":1,"category":"promo"}]',
            rules: rs,
        });
        t.concierge.getState().proposals.push({
            mailId: 'zold',
            from: 'promo@shop.fr',
            subject: 'x',
            category: 'newsletter',
            via: 'signal',
            stage: 'signal',
            ruleId: rule.id,
            proposeArchive: false,
        });
        const ok = await t.concierge.quarantineAct(rule.id, 'reject');
        assert.ok(ok);
        assert.strictEqual(
            rs.all().find((r) => r.id === rule.id),
            undefined,
            'ancienne règle supprimée',
        );
        const negative = rs.all().find((r) => r.when.from === 'promo@shop.fr')!;
        assert.strictEqual(negative.then.category, null);
        assert.strictEqual(negative.origin, 'user');
        assert.strictEqual(negative.confirmed, true);
        const relabel = t.calls.find((c) => c.tool === 'modify_labels')!;
        assert.deepStrictEqual(relabel.args.remove, ['Yui/Newsletters']);
        assert.ok(!('add' in relabel.args));
        assert.ok(
            !t.concierge.getState().proposals.some((p) => p.mailId === 'zold'),
            'proposition de la règle rejetée retirée',
        );

        // Un mail suivant du même expéditeur, avec signal List-Unsubscribe :
        // la règle négative confirmée bloque le signal → part au LLM.
        const t2 = makeConcierge({
            inbox: () => [
                {
                    id: 'z4',
                    from: 'promo@shop.fr',
                    subject: 'S',
                    snippet: '…',
                    headers: { 'List-Unsubscribe': '<x>' },
                    labelIds: [],
                },
            ],
            complete: async () => '[{"i":1,"category":"promo"}]',
            rules: rs,
            readBodies: false,
        });
        const r = await t2.concierge.scan();
        assert.strictEqual(r.classified, 1);
        const p = t2.concierge.getState().proposals[0]!;
        assert.strictEqual(p.via, 'llm');
        assert.strictEqual(p.stage, 'llm');
    }

    // ── Quarantaine : rejeter — une règle négative pour cette adresse existe
    // déjà (rejet antérieur) : pas de doublon ───────────────────────────────
    {
        const rs = new RuleStore(tmp());
        rs.upsert(
            newRule({
                when: { from: 'dup@shop.fr' },
                category: null,
                origin: 'user',
                confirmed: true,
                now: 10,
            }),
        );
        const quarantineRule = newRule({
            when: { from: 'dup@shop.fr' },
            category: 'newsletter',
            origin: 'signal',
            confirmed: false,
            now: 500,
        });
        rs.upsert(quarantineRule);
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            rules: rs,
        });
        const ok = await t.concierge.quarantineAct(quarantineRule.id, 'reject');
        assert.ok(ok);
        const negatives = rs
            .all()
            .filter(
                (r) =>
                    r.when.from === 'dup@shop.fr' && r.then.category === null,
            );
        assert.strictEqual(
            negatives.length,
            1,
            'pas de règle négative dupliquée',
        );
    }

    // ── Étage signal : expéditeur vide — jamais de règle "from:''" (Gmail
    // ignore l'opérateur vide et matcherait toute la boîte), le mail part
    // directement au LLM comme un inconnu ──────────────────────────────────
    {
        const rs = new RuleStore(tmp());
        let n = 0;
        const t = makeConcierge({
            inbox: () => [
                {
                    id: 'e1',
                    from: '',
                    subject: 'S',
                    snippet: 'aperçu',
                    headers: { 'List-Unsubscribe': '<x>' },
                    labelIds: ['INBOX'],
                },
            ],
            readBodies: false,
            complete: async () => {
                n++;
                return '[{"i":1,"category":"lire"}]';
            },
            rules: rs,
        });
        const r = await t.concierge.scan();
        assert.strictEqual(n, 1, 'expéditeur vide → LLM, pas de quarantaine');
        assert.strictEqual(r.classified, 1);
        const p = t.concierge.getState().proposals[0]!;
        assert.strictEqual(p.via, 'llm');
        assert.strictEqual(
            rs.all().find((rule) => rule.when.from === ''),
            undefined,
            'aucune règle "from vide" apprise',
        );
    }

    // ── quarantineAct : une règle de quarantaine sans expéditeur (glissée
    // dans le store avant le garde-fou ci-dessus) ne doit jamais s'exécuter —
    // `from:` vide toucherait toute la boîte via label ─────────────────────
    {
        const rs = new RuleStore(tmp());
        const emptyRule = newRule({
            when: { from: '' },
            category: 'newsletter',
            origin: 'signal',
            confirmed: false,
            now: 500,
        });
        rs.upsert(emptyRule);
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            rules: rs,
        });
        const ok = await t.concierge.quarantineAct(emptyRule.id, 'confirm');
        assert.strictEqual(ok, false);
        assert.strictEqual(
            t.calls.filter(
                (c) =>
                    c.tool === 'list_messages_meta' ||
                    c.tool === 'modify_labels',
            ).length,
            0,
            'aucun appel Gmail sur une règle sans expéditeur',
        );
    }

    // ── Rejet puis correction : la correction doit gagner, pas la règle
    // négative laissée par le rejet (sortRules classe "user" avant
    // "correction" — sans remplacement, la correction restait lettre morte) ─
    {
        const rs = new RuleStore(tmp());
        const quarantineRule = newRule({
            when: { from: 'x@y.fr' },
            category: 'newsletter',
            origin: 'signal',
            confirmed: false,
            now: 500,
        });
        rs.upsert(quarantineRule);
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            rules: rs,
        });
        assert.ok(await t.concierge.quarantineAct(quarantineRule.id, 'reject'));
        const negative = rs.all().find((r) => r.when.from === 'x@y.fr')!;
        assert.strictEqual(negative.then.category, null);

        t.concierge.getState().proposals.push({
            mailId: 'c1',
            from: 'x@y.fr',
            subject: 'S',
            category: 'lire',
            via: 'llm',
            stage: 'llm',
            proposeArchive: false,
        });
        assert.ok(await t.concierge.correct('c1', 'action'));
        const rulesForAddress = rs
            .all()
            .filter((r) => r.when.from === 'x@y.fr');
        assert.strictEqual(
            rulesForAddress.length,
            1,
            'la règle négative est remplacée, pas dupliquée',
        );
        assert.strictEqual(rulesForAddress[0]!.id, negative.id, 'même id');
        assert.strictEqual(rulesForAddress[0]!.then.category, 'action');
        assert.strictEqual(rulesForAddress[0]!.origin, 'correction');
        assert.strictEqual(rulesForAddress[0]!.confirmed, true);

        // Un mail suivant du même expéditeur conclut désormais à l'étage
        // règle, sans LLM.
        let n = 0;
        const t2 = makeConcierge({
            inbox: () => [
                {
                    id: 'c2',
                    from: 'x@y.fr',
                    subject: 'S2',
                    snippet: '',
                    headers: {},
                    labelIds: ['INBOX'],
                },
            ],
            complete: async () => {
                n++;
                return '[]';
            },
            rules: rs,
            readBodies: false,
        });
        const r = await t2.concierge.scan();
        assert.strictEqual(n, 0, 'conclut à l’étage règle, pas de LLM');
        const p2 = t2.concierge.getState().proposals[0]!;
        assert.strictEqual(p2.via, 'rule');
        assert.strictEqual(p2.category, 'action');
    }

    // ── Correction qui promeut une règle de quarantaine : relabellise aussi
    // les AUTRES mails déjà étiquetés avec l'ancien label (pas seulement le
    // mail corrigé) — même rattrapage rétroactif que `quarantineAct('correct')` ─
    {
        const rs = new RuleStore(tmp());
        const quarantineRule = newRule({
            when: { from: 'promo@list.fr' },
            category: 'newsletter',
            origin: 'signal',
            confirmed: false,
            now: 500,
        });
        rs.upsert(quarantineRule);
        const t = makeConcierge({
            inbox: () => [
                {
                    id: 'old1',
                    from: 'promo@list.fr',
                    subject: 'x',
                    snippet: '',
                    headers: {},
                    labelIds: [],
                },
                {
                    id: 'old2',
                    from: 'promo@list.fr',
                    subject: 'y',
                    snippet: '',
                    headers: {},
                    labelIds: [],
                },
            ],
            complete: async () => '[]',
            rules: rs,
        });
        t.concierge.getState().proposals.push({
            mailId: 'c1',
            from: 'promo@list.fr',
            subject: 'S',
            category: 'newsletter',
            via: 'signal',
            stage: 'signal',
            ruleId: quarantineRule.id,
            proposeArchive: false,
        });
        assert.ok(await t.concierge.correct('c1', 'admin'));
        const listCall = t.calls.find((c) => c.tool === 'list_messages_meta')!;
        assert.strictEqual(
            listCall.args.query,
            'from:promo@list.fr label:"Yui/Newsletters"',
        );
        const relabels = t.calls.filter(
            (c) => c.tool === 'modify_labels' && c.args.messageId !== 'c1',
        );
        assert.strictEqual(
            relabels.length,
            2,
            'les 2 vieux mails de quarantaine relabellisés',
        );
        for (const rc of relabels) {
            assert.deepStrictEqual(rc.args.add, ['Yui/Admin']);
            assert.deepStrictEqual(rc.args.remove, ['Yui/Newsletters']);
        }
    }

    // ── saveRule / deleteRule ───────────────────────────────────────────────
    {
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
        });
        const bad = t.concierge.saveRule({
            when: { subject: '[' },
            then: { category: 'action' },
        });
        assert.strictEqual(bad.ok, false, 'regex de sujet invalide refusée');

        const good = t.concierge.saveRule({
            when: { from: 'z@z.fr' },
            then: { category: 'action' },
        });
        assert.ok(good.ok);
        if (!good.ok) throw new Error('unreachable');
        assert.strictEqual(good.rule.origin, 'user');
        assert.strictEqual(good.rule.confirmed, true);
        assert.strictEqual(t.rules.all().length, 1);

        const replaced = t.concierge.saveRule({
            id: good.rule.id,
            when: { from: 'z@z.fr' },
            then: { category: 'perso' },
        });
        assert.ok(replaced.ok);
        if (!replaced.ok) throw new Error('unreachable');
        assert.strictEqual(replaced.rule.id, good.rule.id, 'id conservé');
        assert.strictEqual(
            t.rules.all().length,
            1,
            'remplace, ne duplique pas',
        );
        assert.strictEqual(replaced.rule.then.category, 'perso');

        // Un id fourni qui ne correspond à rien : traité comme une règle neuve.
        const orphanId = t.concierge.saveRule({
            id: 'r-inconnue',
            when: { from: 'q@q.fr' },
            then: { category: 'action' },
        });
        assert.ok(orphanId.ok);
        if (orphanId.ok) assert.notStrictEqual(orphanId.rule.id, 'r-inconnue');

        assert.ok(t.concierge.deleteRule(good.rule.id));
        assert.strictEqual(t.concierge.deleteRule(good.rule.id), false);
        assert.strictEqual(t.concierge.deleteRule('jamais-vue'), false);
    }

    // ── dryRun : trois verdicts, résumé, AUCUNE écriture ─────────────────
    {
        const now = 1000;
        const rule = newRule({
            when: { from: 'edf.fr' },
            category: 'finance',
            origin: 'user',
            confirmed: true,
            now,
        });
        const store = new RuleStore(tmp());
        store.upsert(rule);
        const t = makeConcierge({
            inbox: () => META,
            complete: async () => {
                throw new Error('le dry-run ne doit jamais appeler le LLM');
            },
            rules: store,
            now: () => now,
        });
        const result = await t.concierge.dryRun('newer_than:7d', 50);
        assert.strictEqual(result.query, 'newer_than:7d');
        assert.strictEqual(result.total, 3);
        assert.strictEqual(result.items.length, 3);
        const byId = new Map(result.items.map((i) => [i.id, i]));
        assert.deepStrictEqual(byId.get('m2')!.verdict, {
            stage: 'rule',
            ruleId: rule.id,
            category: 'finance',
            archive: false,
        });
        assert.deepStrictEqual(byId.get('m1')!.verdict, {
            stage: 'signal',
            category: 'newsletter',
            signal: 'list-unsubscribe',
        });
        assert.deepStrictEqual(byId.get('m3')!.verdict, { stage: 'none' });
        assert.deepStrictEqual(result.summary, {
            rule: 1,
            signal: 1,
            none: 1,
            byRule: { [rule.id]: 1 },
        });
        assert.ok(!byId.get('m1')!.alreadyProcessed);

        // Aucune écriture : ni label, ni journal, ni règle apprise, ni processedIds.
        assert.strictEqual(
            t.calls.filter((c) => c.tool === 'modify_labels').length,
            0,
        );
        assert.strictEqual(
            t.calls.filter((c) => c.tool === 'list_messages_meta').length,
            1,
        );
        assert.strictEqual(
            store.all().find((r) => r.id === rule.id)!.hits,
            0,
            'aucun recordHit',
        );
        assert.strictEqual(
            store.all().length,
            1,
            'aucune règle signal apprise',
        );
        assert.strictEqual(t.journal.size(), 0);
        assert.deepStrictEqual(t.concierge.getState().processedIds, []);
        assert.deepStrictEqual(t.concierge.getState().proposals, []);

        // max plafonné à 200 côté list_messages_meta, même si demandé plus haut.
        let seenMax: unknown;
        const t2 = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            extra: {
                deviceHandler: async (tool, args) => {
                    if (tool === 'list_messages_meta') {
                        seenMax = args?.maxResults;
                        return [];
                    }
                    return 'ok';
                },
            },
        });
        await t2.concierge.dryRun('q', 500);
        assert.strictEqual(seenMax, 200);
    }

    // ── dryRun : un mail déjà traité est réévalué mais marqué alreadyProcessed ──
    {
        let completeCalls = 0;
        const t = makeConcierge({
            inbox: () => [META[1]],
            readBodies: false,
            complete: async () => {
                completeCalls++;
                return '[{"i":1,"category":"finance"}]';
            },
        });
        await t.concierge.scan();
        assert.strictEqual(completeCalls, 1);
        const dry = await t.concierge.dryRun('any', 10);
        assert.strictEqual(
            completeCalls,
            1,
            'dry-run ne relance jamais le LLM',
        );
        const item = dry.items.find((i) => i.id === 'm2')!;
        assert.strictEqual(item.alreadyProcessed, true);
        assert.strictEqual(item.verdict.stage, 'none');
    }

    // ── classifyMails : id absent du cache → skipped ─────────────────────
    {
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
        });
        const r = await t.concierge.classifyMails(['fantome']);
        assert.deepStrictEqual(r, { classified: 0, skipped: ['fantome'] });
    }

    // ── classifyMails : mail en cache (dry-run) → proposition via:'llm' ──
    {
        let completeCalls = 0;
        const t = makeConcierge({
            inbox: () => [META[2]],
            readBodies: false,
            complete: async (_s, u) => {
                completeCalls++;
                assert.ok(u.includes('Plan Immobilier'));
                return '[{"i":1,"category":"osef"}]';
            },
        });
        const dry = await t.concierge.dryRun();
        assert.strictEqual(dry.items[0]!.verdict.stage, 'none');
        assert.strictEqual(completeCalls, 0, 'dry-run seul ne classe rien');
        const res = await t.concierge.classifyMails(['m3']);
        assert.strictEqual(completeCalls, 1);
        assert.deepStrictEqual(res, { classified: 1, skipped: [] });
        const st = t.concierge.getState();
        const p = st.proposals.find((x) => x.mailId === 'm3')!;
        assert.strictEqual(p.via, 'llm');
        assert.strictEqual(p.category, 'osef');
        assert.ok(st.processedIds.includes('m3'));
        assert.strictEqual(t.journal.size(), 1);
        assert.strictEqual(
            t.calls.filter((c) => c.tool === 'modify_labels').length,
            0,
            'catégorie pas en autoCategories : proposition seule',
        );
    }

    // ── classifyMails : plafond LLM_PER_POLL (24), le reste attend ───────
    {
        const many = Array.from({ length: 30 }, (_, i) => unknownMail(i));
        let batches = 0;
        const t = makeConcierge({
            inbox: () => many,
            readBodies: false,
            complete: async (_s, u) => {
                batches++;
                const count = (u.match(/^\d+\. De:/gm) ?? []).length;
                return JSON.stringify(
                    Array.from({ length: count }, (_, i) => ({
                        i: i + 1,
                        category: 'lire',
                    })),
                );
            },
        });
        await t.concierge.dryRun('in:inbox', 100);
        const res = await t.concierge.classifyMails(many.map((m) => m.id));
        assert.strictEqual(res.classified, 24);
        assert.deepStrictEqual(res.skipped, []);
        assert.strictEqual(t.concierge.getState().processedIds.length, 24);
        assert.strictEqual(batches, 2, '24 mails = 2 lots de 12');
    }

    // ── classifyMails : mail déjà traité → ignoré (ni classé, ni skipped) ──
    {
        const t = makeConcierge({
            inbox: () => [META[1]],
            readBodies: false,
            complete: async () => '[{"i":1,"category":"finance"}]',
        });
        await t.concierge.scan();
        await t.concierge.dryRun();
        const res = await t.concierge.classifyMails(['m2']);
        assert.deepStrictEqual(res, { classified: 0, skipped: [] });
    }

    // ── replaceRules : validation tout-ou-rien, remplace le fichier ─────────
    {
        const store = new RuleStore(tmp());
        store.upsert(
            newRule({
                when: { from: 'old.fr' },
                category: 'lire',
                origin: 'user',
                confirmed: true,
                now: 1,
            }),
        );
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            rules: store,
        });

        const dup = t.concierge.replaceRules({
            version: 1,
            rules: [
                {
                    id: 'r-a',
                    when: { from: 'a@b.fr' },
                    then: { category: 'lire' },
                    origin: 'user',
                    confirmed: true,
                    hits: 0,
                    createdAt: 1,
                },
                {
                    id: 'r-a',
                    when: { from: 'c@d.fr' },
                    then: { category: 'lire' },
                    origin: 'user',
                    confirmed: true,
                    hits: 0,
                    createdAt: 2,
                },
            ],
        });
        assert.strictEqual(dup.ok, false);
        if (!dup.ok) {
            assert.strictEqual(dup.errors.length, 1);
            assert.strictEqual(dup.errors[0]!.index, 1);
            assert.strictEqual(dup.errors[0]!.id, 'r-a');
        }

        const badCat = t.concierge.replaceRules({
            version: 1,
            rules: [
                {
                    id: 'r-b',
                    when: { from: 'x@y.fr' },
                    then: { category: 'nawak' },
                    origin: 'user',
                    confirmed: true,
                    hits: 0,
                    createdAt: 1,
                },
            ],
        });
        assert.strictEqual(badCat.ok, false);
        if (!badCat.ok) assert.strictEqual(badCat.errors[0]!.index, 0);

        const badRegex = t.concierge.replaceRules({
            version: 1,
            rules: [
                {
                    id: 'r-c',
                    when: { subject: '(' },
                    then: { category: 'lire' },
                    origin: 'user',
                    confirmed: true,
                    hits: 0,
                    createdAt: 1,
                },
            ],
        });
        assert.strictEqual(badRegex.ok, false);
        if (!badRegex.ok) assert.strictEqual(badRegex.errors[0]!.index, 0);

        // Rien n'a bougé après les échecs (tout-ou-rien).
        assert.strictEqual(store.all().length, 1);
        assert.strictEqual(store.all()[0]!.when.from, 'old.fr');

        const badVersion = t.concierge.replaceRules({ version: 2, rules: [] });
        assert.strictEqual(badVersion.ok, false);
        const notArray = t.concierge.replaceRules({
            version: 1,
            rules: 'nope',
        });
        assert.strictEqual(notArray.ok, false);

        const invalids = t.concierge.replaceRules({
            version: 1,
            rules: [
                {
                    id: '',
                    when: { from: 'a@a.fr' },
                    then: { category: 'lire' },
                    origin: 'user',
                    confirmed: true,
                },
                {
                    id: 'r-o',
                    when: { from: 'b@b.fr' },
                    then: { category: 'lire' },
                    origin: 'nawak',
                    confirmed: true,
                },
                {
                    id: 'r-p',
                    when: { from: 'c@c.fr' },
                    then: { category: 'lire' },
                    origin: 'user',
                    confirmed: 'oui',
                },
            ],
        });
        assert.strictEqual(invalids.ok, false);
        if (!invalids.ok) assert.strictEqual(invalids.errors.length, 3);

        const defaults = t.concierge.replaceRules({
            version: 1,
            rules: [
                {
                    id: 'r-d',
                    when: { from: 'd@e.fr' },
                    then: { category: 'lire' },
                    origin: 'user',
                    confirmed: true,
                },
            ],
        });
        assert.ok(defaults.ok);
        assert.strictEqual(store.all()[0]!.hits, 0, 'défaut 0');
        assert.ok(store.all()[0]!.createdAt > 0, 'défaut now');

        const ok = t.concierge.replaceRules({
            version: 1,
            rules: [
                {
                    id: 'r-1',
                    when: { from: 'a@b.fr' },
                    then: { category: 'lire' },
                    origin: 'user',
                    confirmed: true,
                    hits: 3,
                    createdAt: 10,
                },
                {
                    id: 'r-2',
                    when: { from: 'x@y.fr' },
                    then: { category: null },
                    origin: 'signal',
                    confirmed: false,
                    hits: 0,
                    createdAt: 20,
                },
            ],
        });
        assert.deepStrictEqual(ok, { ok: true, count: 2 });
        assert.deepStrictEqual(
            store.all().map((r) => r.id),
            ['r-1', 'r-2'],
        );
        assert.strictEqual(store.all()[0]!.hits, 3);
        assert.strictEqual(store.all()[1]!.confirmed, false);

        // rulesFile() : tout le fichier, y compris une règle signal non confirmée.
        const file = t.concierge.rulesFile();
        assert.strictEqual(file.version, 1);
        assert.deepStrictEqual(
            file.rules.map((r) => r.id),
            ['r-1', 'r-2'],
        );
    }

    // ── reading() / markRead() ───────────────────────────────────────────────
    {
        let seenArgs: any;
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            extra: {
                deviceHandler: async (tool, args) => {
                    if (tool === 'list_messages_meta') {
                        seenArgs = args;
                        return [
                            {
                                id: 'r1',
                                from: 'a@b.fr',
                                subject: 'S',
                                date: '2026-01-01',
                                snippet: 'sn',
                            },
                            { from: 'sans id' },
                        ];
                    }
                    return 'ok';
                },
            },
        });
        const result = await t.concierge.reading();
        assert.deepStrictEqual(seenArgs, {
            query: 'label:"Yui/A lire" is:unread',
            maxResults: 50,
        });
        assert.deepStrictEqual(result, [
            {
                id: 'r1',
                from: 'a@b.fr',
                subject: 'S',
                date: '2026-01-01',
                snippet: 'sn',
            },
        ]);
        await t.concierge.reading(5);
        assert.strictEqual(seenArgs.maxResults, 5);
    }
    {
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
        });
        await t.concierge.markRead('m9');
        const call = t.calls.find((c) => c.tool === 'mark_read')!;
        assert.deepStrictEqual(call.args, { messageId: 'm9' });
    }

    // ── listJournal() ─────────────────────────────────────────────────────
    {
        const jr = new MailJournal(tmp());
        jr.add({
            at: 1,
            mailId: 'x',
            from: 'a',
            subject: 'b',
            category: 'lire',
            stage: 'llm',
            applied: false,
        });
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            journal: jr,
        });
        assert.strictEqual(t.concierge.listJournal().length, 1);
        assert.strictEqual(t.concierge.listJournal(0).length, 0);
    }

    // ── recentSenders / applyRule / stats (Courrier v2) ───────────────────
    {
        const now = Date.parse('2026-10-05T12:00:00Z');
        const store = new RuleStore(tmp());
        const edf = newRule({
            when: { from: 'edf.fr' },
            category: 'finance',
            origin: 'user',
            confirmed: true,
            now,
        });
        const neg = newRule({
            when: { from: 'ami@gmail.com' },
            category: null,
            origin: 'user',
            confirmed: true,
            now,
        });
        store.upsert(edf);
        store.upsert(neg);
        const mk = (
            id: string,
            from: string,
            subject: string,
            date: string,
        ) => ({
            id,
            threadId: `t${id}`,
            from,
            subject,
            snippet: '',
            headers: {} as Record<string, string>,
            labelIds: ['INBOX'],
            date,
        });
        const inbox = [
            mk(
                'a1',
                'EDF <service@edf.fr>',
                'Facture mars',
                'Mon, 02 Mar 2026 10:00:00 +0000',
            ),
            mk(
                'a2',
                'EDF <service@edf.fr>',
                'Facture avril',
                'Wed, 01 Apr 2026 10:00:00 +0000',
            ),
            mk(
                'b1',
                'Ami <ami@gmail.com>',
                'Salut',
                'Tue, 31 Mar 2026 10:00:00 +0000',
            ),
            mk(
                'c1',
                'Inconnu <x@inconnu.fr>',
                'Hello',
                'Tue, 31 Mar 2026 09:00:00 +0000',
            ),
        ];
        const t = makeConcierge({
            inbox: () => inbox,
            complete: async () => {
                throw new Error('jamais de LLM');
            },
            rules: store,
            now: () => now,
        });
        const senders = await t.concierge.recentSenders(30, 500);
        assert.strictEqual(t.calls.length, 1);
        assert.strictEqual(t.calls[0]!.args.query, 'newer_than:30d');
        assert.strictEqual(t.calls[0]!.args.maxResults, 200, 'max borné à 200');
        assert.ok(
            t.calls.every((c) => c.tool === 'list_messages_meta'),
            'aucune écriture',
        );
        assert.strictEqual(senders.length, 3);
        const e = senders[0]!;
        assert.strictEqual(e.address, 'service@edf.fr');
        assert.strictEqual(e.domain, 'edf.fr');
        assert.strictEqual(e.name, 'EDF');
        assert.strictEqual(e.count, 2);
        assert.strictEqual(e.lastSubject, 'Facture avril');
        assert.deepStrictEqual(e.verdict, {
            stage: 'rule',
            ruleId: edf.id,
            category: 'finance',
        });
        assert.strictEqual(e.domainRuleAllowed, true);
        const ami = senders.find((s) => s.address === 'ami@gmail.com')!;
        assert.strictEqual(ami.domainRuleAllowed, false);
        assert.deepStrictEqual(ami.verdict, {
            stage: 'rule',
            ruleId: neg.id,
            category: null,
        });
        assert.deepStrictEqual(
            senders.find((s) => s.address === 'x@inconnu.fr')!.verdict,
            { stage: 'none' },
        );
        await t.concierge.recentSenders(30, 500);
        assert.strictEqual(t.calls.length, 1, 'cache 60 s');
    }

    {
        const store = new RuleStore(tmp());
        const t = makeConcierge({
            inbox: () => [
                {
                    id: 'k1',
                    threadId: 't',
                    from: 'K <k@k.fr>',
                    subject: 's',
                    snippet: '',
                    headers: {},
                    labelIds: [],
                    date: '',
                },
                { id: 'k2', from: '', subject: '', labelIds: [] },
            ],
            complete: async () => '[]',
            rules: store,
        });
        const before = await t.concierge.recentSenders(30, 200);
        assert.strictEqual(before.length, 1, 'adresse vide ignorée');
        assert.strictEqual(before[0]!.verdict.stage, 'none');
        store.upsert(
            newRule({
                when: { from: 'k.fr' },
                category: 'osef',
                origin: 'user',
                confirmed: true,
                now: 1000,
            }),
        );
        const after = await t.concierge.recentSenders(30, 200);
        assert.strictEqual(after[0]!.verdict.stage, 'rule');
    }

    {
        let clock = 1000;
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            now: () => clock,
        });
        await t.concierge.recentSenders(30, 200);
        clock += 61_000;
        await t.concierge.recentSenders(30, 200);
        assert.strictEqual(t.calls.length, 2, 'cache expiré après 60 s');
    }

    {
        const store = new RuleStore(tmp());
        const rule = newRule({
            when: { from: 'zalando.fr' },
            category: 'promo',
            origin: 'user',
            confirmed: true,
            now: 1000,
        });
        const negRule = newRule({
            when: { from: 'neg.fr' },
            category: null,
            origin: 'user',
            confirmed: true,
            now: 1000,
        });
        const subjRule = newRule({
            when: { from: 'z.fr', subject: 'x' },
            category: 'promo',
            origin: 'user',
            confirmed: true,
            now: 1000,
        });
        const unconf = newRule({
            when: { from: 'u.fr' },
            category: 'promo',
            origin: 'signal',
            confirmed: false,
            now: 1000,
        });
        for (const r of [rule, negRule, subjRule, unconf]) store.upsert(r);
        const inbox = [1, 2, 3].map((i) => ({
            id: `z${i}`,
            threadId: `t${i}`,
            from: 'Z <a@zalando.fr>',
            subject: 's',
            snippet: '',
            headers: {},
            labelIds: ['INBOX'],
            date: '',
        }));
        const t = makeConcierge({
            inbox: () => inbox,
            complete: async () => '[]',
            rules: store,
        });
        const failing = new MailConcierge(
            {
                deviceHandler: async (tool, args) => {
                    t.calls.push({ tool, args });
                    if (tool === 'list_messages_meta') return inbox;
                    if (args?.messageId === 'z2') throw new Error('boom');
                    return 'ok';
                },
                complete: async () => '[]',
                rules: store,
                journal: t.journal,
                getAutoCategories: () => [],
                now: () => 1000,
            },
            tmp(),
        );
        const res = await failing.applyRule(rule.id, 500);
        const list = t.calls.find((c) => c.tool === 'list_messages_meta')!;
        assert.strictEqual(list.args.query, 'from:"zalando.fr" newer_than:90d');
        assert.strictEqual(list.args.maxResults, 100);
        const mods = t.calls.filter((c) => c.tool === 'modify_labels');
        assert.strictEqual(
            mods.length,
            3,
            "un échec n'interrompt pas les autres",
        );
        assert.strictEqual(mods[0]!.args.archive, true, 'promo archive');
        assert.deepStrictEqual(mods[0]!.args.add, ['Yui/Promos']);
        assert.strictEqual(res.applied, 2);
        assert.strictEqual(res.archived, 2);
        assert.deepStrictEqual(failing.getState().processedIds.sort(), [
            'z1',
            'z3',
        ]);
        const entries = t.journal.list(10);
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0]!.reason, 'application rétroactive');
        assert.strictEqual(entries[0]!.ruleId, rule.id);
        assert.strictEqual(
            store.all().find((r) => r.id === rule.id)!.hits,
            0,
            'recordHit non appelé',
        );
        const before = t.calls.length;
        for (const id of [negRule.id, subjRule.id, unconf.id]) {
            const r = await failing.applyRule(id);
            assert.strictEqual(r.applied, 0);
            assert.strictEqual(r.archived, 0);
            assert.strictEqual(r.refused, 'not-applicable');
        }
        assert.strictEqual(
            (await failing.applyRule('nope')).refused,
            'unknown',
        );
        assert.strictEqual(t.calls.length, before, 'refus sans appel Gmail');
    }

    {
        const now = Date.parse('2026-10-05T12:00:00Z');
        const jr = new MailJournal(tmp());
        const add = (stage: any, category: string, ageDays: number) =>
            jr.add({
                at: now - ageDays * 86_400_000,
                mailId: 'x',
                from: 'a',
                subject: 'b',
                category,
                stage,
                applied: true,
            });
        add('rule', 'finance', 20);
        add('rule', 'finance', 2);
        add('signal', 'newsletter', 1);
        add('llm', 'lire', 0);
        add('rule', 'promo', 0);
        const t = makeConcierge({
            inbox: () => [],
            complete: async () => '[]',
            journal: jr,
            now: () => now,
        });
        const s = t.concierge.stats(7);
        assert.strictEqual(s.days, 7);
        assert.deepStrictEqual(s.byStage, {
            rule: 2,
            signal: 1,
            llm: 1,
            fallback: 0,
        });
        assert.deepStrictEqual(s.byCategory, {
            finance: 1,
            newsletter: 1,
            lire: 1,
            promo: 1,
        });
        assert.strictEqual(s.quarantine, 0);
        assert.strictEqual(s.reading, 0);
    }

    console.log('All concierge tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
