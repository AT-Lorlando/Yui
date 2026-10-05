import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// Le concierge persiste son état via dataPath() : isoler YUI_DATA_DIR AVANT de
// résoudre ./mail (même contrainte que connectors.test.ts).
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-mailc-'));
const { mailConnector, capLegacyImportance } =
    require('./mail') as typeof import('./mail');
const { MailConcierge } =
    require('../mail/concierge') as typeof import('../mail/concierge');
const { ConnectorState } =
    require('../connectorState') as typeof import('../connectorState');
const { RuleStore } =
    require('../mail/rules') as typeof import('../mail/rules');
const { MailJournal } =
    require('../mail/journal') as typeof import('../mail/journal');
import type { ConnectorContext } from '../connector';
import type { TriageProposal } from '../mail/concierge';

const NOW = new Date('2026-09-25T10:00:00').getTime();
// Format réel de search_emails, tel que parseSearchOutput() le découpe
// (`ID:`, `De:`, `Objet:`, `Apercu:` — sans accent) — lu par le watcher
// des mails importants.
const SEARCH =
    'ID: m1\nDe: LinkedIn <jobs@linkedin.com>\nObjet: Nouvelle proposition DevOps\nDate: 2026-09-25\nApercu: Un recruteur…\n';
// Forme réelle de list_messages_meta (déjà parsée) — lue par le concierge.
const META = [
    {
        id: 'm1',
        threadId: 't1',
        from: 'LinkedIn <jobs@linkedin.com>',
        subject: 'Nouvelle proposition DevOps',
        snippet: 'Un recruteur…',
        headers: {},
        labelIds: ['INBOX'],
    },
];

async function run(): Promise<void> {
    let scans = 0;
    const concierge = new MailConcierge(
        {
            deviceHandler: async (t) =>
                t === 'list_messages_meta'
                    ? META
                    : t === 'get_email'
                    ? 'corps'
                    : null,
            // parseClassifyReply() indexe les mails par `i` (1-based).
            complete: async () => '[{"i":1,"category":"action"}]',
            rules: new RuleStore(
                path.join(process.env.YUI_DATA_DIR!, 'rules.json'),
            ),
            journal: new MailJournal(
                path.join(process.env.YUI_DATA_DIR!, 'journal.json'),
            ),
            getAutoCategories: () => [],
            readBodies: false,
            now: () => NOW,
        },
        path.join(process.env.YUI_DATA_DIR!, 'triage.json'),
    );
    const origScan = concierge.scan.bind(concierge);
    concierge.scan = async (...a) => {
        scans++;
        return origScan(...a);
    };

    const state = new ConnectorState();
    const toolCalls: string[] = [];
    const ctx = (settings: Record<string, unknown>): ConnectorContext => ({
        callTool: async (t) => {
            toolCalls.push(t);
            return t === 'search_emails'
                ? SEARCH
                : t === 'list_messages_meta'
                ? META
                : null;
        },
        settings,
        state,
        presence: () => 'home',
        now: () => NOW,
        log: { info: () => {}, warn: () => {} },
    });
    const c = mailConnector({ concierge });

    // Tri inactif : seulement les mails importants (evaluateMail), jamais
    // au-dessus de « utile » — ils sont retenus, pas jugés.
    const off = await c.events!(ctx({ triage: false, query: 'is:important' }));
    assert.strictEqual(scans, 0);
    assert.strictEqual(off.length, 1);
    assert.strictEqual(off[0]!.key, 'important-mail');
    assert.ok(
        off[0]!.importance === 'utile' || off[0]!.importance === 'info',
        'le veilleur historique ne dépasse jamais utile',
    );
    assert.strictEqual(capLegacyImportance('urgent'), 'utile');
    assert.strictEqual(capLegacyImportance('critique'), 'utile');
    assert.strictEqual(capLegacyImportance('utile'), 'utile');
    assert.strictEqual(capLegacyImportance('info'), 'info');

    // Tri actif : le concierge est seul maître — le veilleur historique ne
    // tourne pas (pas de search_emails, aucun événement « important-mail »),
    // scan + un événement par action, jamais répété.
    toolCalls.length = 0;
    const on = await c.events!(ctx({ triage: true }));
    assert.strictEqual(scans, 1);
    assert.ok(
        !toolCalls.includes('search_emails'),
        'tri actif → evaluateMail ne tourne pas',
    );
    assert.ok(
        !on.some((e) => e.key === 'important-mail'),
        'tri actif → aucun événement du veilleur historique',
    );
    const action = on.find((e) => e.key === 'mail-action-m1');
    assert.ok(action && action.kind === 'request');
    // L'intention todo porte le sujet et l'id Gmail (retrouvable depuis Yoji).
    assert.deepStrictEqual(action!.todo, {
        title: 'Répondre : Nouvelle proposition DevOps',
        description: 'De LinkedIn <jobs@linkedin.com> — gmail:m1',
    });
    assert.ok(
        !on.some((e) => e.key === 'mail-doubts' && e.todo),
        'les doutes ne font pas de post-it',
    );
    const again = await c.events!(ctx({ triage: true }));
    assert.ok(!again.some((e) => e.key === 'mail-action-m1'), 'déjà signalé');

    const snap = await c.snapshot!(ctx({ triage: true }));
    assert.ok(snap.some((f) => f.label === 'Courrier'));
    assert.ok(
        snap.some((f) => f.label === 'À traiter' && f.value.includes('DevOps')),
    );

    // ── Urgence : routage vers le juge, plafond quotidien, reset au jour
    // suivant ────────────────────────────────────────────────────────────
    {
        let urgentNow = NOW;
        const urgentConcierge = new MailConcierge(
            {
                deviceHandler: async (t) =>
                    t === 'list_messages_meta' ? [] : null,
                complete: async () => '[]',
                rules: new RuleStore(
                    path.join(process.env.YUI_DATA_DIR!, 'rules-urg.json'),
                ),
                journal: new MailJournal(
                    path.join(process.env.YUI_DATA_DIR!, 'journal-urg.json'),
                ),
                getAutoCategories: () => [],
                now: () => urgentNow,
            },
            path.join(process.env.YUI_DATA_DIR!, 'triage-urg.json'),
        );
        const push = (over: Partial<TriageProposal>) =>
            urgentConcierge.getState().proposals.push({
                from: 'X <x@y.fr>',
                subject: 'Sujet',
                proposeArchive: false,
                via: 'llm',
                stage: 'llm',
                ...over,
            } as TriageProposal);
        const urgentState = new ConnectorState();
        const urgentCtx = (settings: Record<string, unknown>) => ({
            ...ctx(settings),
            state: urgentState,
            now: () => urgentNow,
        });
        const cUrgent = mailConnector({ concierge: urgentConcierge });

        // Une proposition "lire" (jamais une action) mais urgency "now" :
        // devient quand même un événement, urgent, avec la raison en fait.
        push({
            mailId: 'u1',
            category: 'lire',
            urgency: 'now',
            reason: 'Réponse attendue aujourd’hui',
        });
        const r1 = await cUrgent.events!(urgentCtx({ triage: true }));
        const e1 = r1.find((e) => e.key === 'mail-action-u1')!;
        assert.strictEqual(e1.importance, 'urgent');
        assert.ok(e1.facts.some((f) => f.includes('Réponse attendue')));

        // Une proposition "lire" avec urgency "none" (ni action ni urgente) :
        // aucun événement.
        push({ mailId: 'u2', category: 'lire', urgency: 'none' });
        const r2 = await cUrgent.events!(urgentCtx({ triage: true }));
        assert.ok(!r2.some((e) => e.key === 'mail-action-u2'));

        // Trois nouvelles propositions "now" le même jour : le plafond (2/jour,
        // u1 a déjà pris le premier) laisse passer une seule "urgent", la
        // suivante retombe en "utile" avec le fait de plafond.
        push({ mailId: 'u3', category: 'lire', urgency: 'now' });
        push({ mailId: 'u4', category: 'lire', urgency: 'now' });
        const r3 = await cUrgent.events!(urgentCtx({ triage: true }));
        const e3 = r3.find((e) => e.key === 'mail-action-u3')!;
        const e4 = r3.find((e) => e.key === 'mail-action-u4')!;
        assert.strictEqual(e3.importance, 'urgent');
        assert.strictEqual(e4.importance, 'utile');
        assert.ok(
            e4.facts.some((f) => f.includes('Urgence plafonnée')),
            'plafond atteint → fait dédié',
        );

        // Jour suivant : le plafond est réinitialisé, une nouvelle urgence
        // repasse "urgent".
        urgentNow = NOW + 24 * 3600_000;
        push({ mailId: 'u5', category: 'lire', urgency: 'now' });
        const r4 = await cUrgent.events!(urgentCtx({ triage: true }));
        const e5 = r4.find((e) => e.key === 'mail-action-u5')!;
        assert.strictEqual(e5.importance, 'urgent', 'plafond réinitialisé');
    }

    console.log('All mail connector tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
