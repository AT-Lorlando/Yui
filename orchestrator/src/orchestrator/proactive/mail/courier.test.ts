import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    MailCourier,
    CourierDeps,
    LLM_PER_POLL,
    READ_MAX_TRIES,
    SWEEP_EVERY_MS,
    parseMetaList,
} from './courier';
import {
    SenderStore,
    SPAM_LABEL,
    newKeepSender,
    newSpamSender,
} from './senders';
import { OrderStore } from './orders';
import { BadRequestError, NotFoundError } from './errors';
import { MailJournal } from './journal';
import type { ReaderItem } from './reader';

const NOW = 1_800_000_000_000;

interface Call {
    tool: string;
    args: Record<string, unknown>;
}

interface Meta {
    id: string;
    from: string;
    subject: string;
    headers?: Record<string, string>;
    snippet?: string;
}

function meta(m: Meta): Record<string, unknown> {
    return {
        id: m.id,
        threadId: 't' + m.id,
        from: m.from,
        subject: m.subject,
        snippet: m.snippet ?? 'snippet ' + m.id,
        headers: m.headers ?? {},
        labelIds: ['INBOX'],
        date: '2026-10-14',
    };
}

function setup(opts: {
    list?: (query: string) => Meta[];
    replies?: Array<string | Error>;
    keepRead?: 'always' | 'never';
}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-'));
    const senders = new SenderStore(path.join(dir, 'senders.json'));
    const qonto = newKeepSender(
        { match: 'qonto.com', name: 'Qonto', read: opts.keepRead ?? 'always' },
        NOW,
    );
    senders.upsertKeep(qonto);
    const spam = newSpamSender('promo.io', NOW);
    senders.upsertSpam(spam);
    const orders = new OrderStore(path.join(dir, 'orders.json'));
    const journal = new MailJournal(path.join(dir, 'journal.json'));
    const calls: Call[] = [];
    const prompts: Array<{ system: string; user: string }> = [];
    const notified: Array<{ mailId: string; item: ReaderItem }> = [];
    const facts: Array<{ mailId: string; item: ReaderItem }> = [];
    const replies = [...(opts.replies ?? [])];
    let now = NOW;
    const deps: CourierDeps = {
        deviceHandler: async (tool, args = {}) => {
            calls.push({ tool, args });
            if (tool === 'list_messages_meta') {
                return JSON.stringify(
                    (opts.list?.(String(args.query)) ?? []).map(meta),
                );
            }
            if (tool === 'get_email') {
                return `From: x\n--- Corps ---\nCorps du mail ${args.messageId}`;
            }
            return 'ok';
        },
        complete: async (system, user) => {
            prompts.push({ system, user });
            const r = replies.shift();
            if (r instanceof Error) throw r;
            if (r === undefined) throw new Error('no scripted reply');
            return r;
        },
        senders,
        orders,
        journal,
        readerPrompt: () => 'ORDRE GENERAL',
        onNotify: (m, item) => notified.push({ mailId: m.mailId, item }),
        onFacts: (m, item) => facts.push({ mailId: m.mailId, item }),
        now: () => now,
    };
    const stateFile = path.join(dir, 'courier.json');
    const courier = new MailCourier(deps, stateFile);
    return {
        courier,
        deps,
        calls,
        prompts,
        notified,
        facts,
        senders,
        orders,
        journal,
        stateFile,
        qonto,
        spam,
        setNow: (t: number) => (now = t),
    };
}

const byTool = (calls: Call[], tool: string) =>
    calls.filter((c) => c.tool === tool);

async function run() {
    // parseMetaList : texte JSON, tableau, déchets
    assert.strictEqual(parseMetaList('pas du json').length, 0);
    assert.strictEqual(parseMetaList([{ from: 'x' }]).length, 0);
    assert.strictEqual(
        parseMetaList([meta({ id: 'a', from: 'f', subject: 's' })])[0].threadId,
        'ta',
    );

    // (a) gardé lu + notify → label Boîtes/Qonto + archive, onNotify, journal keep/read/notify
    {
        const t = setup({
            list: () => [
                {
                    id: 'm1',
                    from: 'Qonto <hello@qonto.com>',
                    subject: 'Paiement reçu',
                },
            ],
            replies: [
                '[{"i":1,"notify":true,"urgency":"now","reason":"Paiement de 120 €","facts":["120 €"]}]',
            ],
        });
        const r = await t.courier.scan();
        const mod = byTool(t.calls, 'modify_labels');
        assert.strictEqual(mod.length, 1);
        assert.deepStrictEqual(mod[0].args, {
            messageId: 'm1',
            add: ['Boîtes/Qonto'],
            archive: true,
        });
        assert.strictEqual(byTool(t.calls, 'get_email').length, 1);
        assert.ok(t.prompts[0].system.startsWith('ORDRE GENERAL'));
        assert.ok(t.prompts[0].user.includes('Corps du mail m1'));
        assert.ok(t.prompts[0].user.includes('Boîte: Qonto'));
        assert.strictEqual(t.notified.length, 1);
        assert.strictEqual(t.notified[0].mailId, 'm1');
        assert.strictEqual(t.facts.length, 0);
        const d = t.journal.list(1)[0];
        assert.strictEqual(d.stage, 'keep');
        assert.strictEqual(d.box, 'Qonto');
        assert.strictEqual(d.read, true);
        assert.strictEqual(d.notify, true);
        assert.strictEqual(d.urgency, 'now');
        assert.deepStrictEqual(r, {
            scanned: 1,
            kept: 1,
            spammed: 0,
            inbox: 0,
            read: 1,
            notified: 1,
        });
        assert.strictEqual(t.senders.keep()[0].hits, 1);
        assert.deepStrictEqual(t.courier.getState().processedIds, ['m1']);
        // persistance + pas de relecture d'un mail traité
        const again = new MailCourier(t.deps, t.stateFile);
        assert.deepStrictEqual(again.getState().processedIds, ['m1']);
        const r2 = await again.scan();
        assert.strictEqual(r2.read, 0);
        assert.strictEqual(byTool(t.calls, 'modify_labels').length, 1);
    }

    // gardé non lu → label + archive, journal keep read:false, aucun LLM
    {
        const t = setup({
            keepRead: 'never',
            list: () => [{ id: 'n1', from: 'x@qonto.com', subject: 'Relevé' }],
        });
        const r = await t.courier.scan();
        assert.strictEqual(t.prompts.length, 0);
        assert.strictEqual(byTool(t.calls, 'get_email').length, 0);
        const d = t.journal.list(1)[0];
        assert.strictEqual(d.stage, 'keep');
        assert.strictEqual(d.read, false);
        assert.strictEqual(r.kept, 1);
    }

    // (b) spam → Yui/Spam + archive, pas de get_email
    {
        const t = setup({
            list: () => [
                { id: 's1', from: 'deals@promo.io', subject: '-50 %' },
            ],
        });
        const r = await t.courier.scan();
        const mod = byTool(t.calls, 'modify_labels');
        assert.deepStrictEqual(mod[0].args, {
            messageId: 's1',
            add: [SPAM_LABEL],
            archive: true,
        });
        assert.strictEqual(byTool(t.calls, 'get_email').length, 0);
        assert.strictEqual(t.prompts.length, 0);
        assert.strictEqual(t.journal.list(1)[0].stage, 'spam');
        assert.strictEqual(t.journal.list(1)[0].read, false);
        assert.strictEqual(r.spammed, 1);
        assert.strictEqual(t.senders.spam()[0].hits, 1);
    }

    // (c) inconnu avec List-Unsubscribe → unknown() + signal, lu, onFacts
    {
        const t = setup({
            list: () => [
                {
                    id: 'u1',
                    from: 'Michel <Michel@Exemple.fr>',
                    subject: 'Devis',
                    headers: { 'List-Unsubscribe': '<mailto:x>' },
                },
            ],
            replies: [
                '[{"i":1,"notify":false,"reason":"Devis reçu","facts":["Devis : 1 240 €"]}]',
            ],
        });
        const r = await t.courier.scan();
        assert.strictEqual(byTool(t.calls, 'modify_labels').length, 0);
        const u = t.courier.unknown();
        assert.strictEqual(u.length, 1);
        assert.strictEqual(u[0].address, 'michel@exemple.fr');
        assert.strictEqual(u[0].signal, 'list-unsubscribe');
        assert.strictEqual(u[0].count, 1);
        assert.strictEqual(u[0].lastMailId, 'u1');
        assert.strictEqual(t.facts.length, 1);
        assert.strictEqual(t.notified.length, 0);
        const d = t.journal.list(1)[0];
        assert.strictEqual(d.stage, 'inbox');
        assert.strictEqual(d.read, true);
        assert.strictEqual(d.notify, false);
        assert.strictEqual(r.inbox, 1);
        t.courier.forgetUnknown('MICHEL@exemple.fr');
        assert.strictEqual(t.courier.unknown().length, 0);
    }

    // file des inconnus plafonnée à 200 (le plus ancien lastAt sort), unknown() ≤ 100
    {
        let n = 0;
        const t = setup({
            list: () =>
                Array.from({ length: 1 }, () => ({
                    id: 'x' + n,
                    from: `p${n}@ex.fr`,
                    subject: 's',
                })),
            replies: Array.from(
                { length: 205 },
                () => '[{"i":1,"notify":false}]',
            ),
        });
        for (n = 0; n < 205; n++) {
            t.setNow(NOW + n);
            await t.courier.scan();
        }
        const all = Object.keys(t.courier.getState().unknown);
        assert.strictEqual(all.length, 200);
        assert.ok(!all.includes('p0@ex.fr'));
        assert.ok(all.includes('p204@ex.fr'));
        const u = t.courier.unknown();
        assert.strictEqual(u.length, 100);
        assert.strictEqual(u[0].address, 'p204@ex.fr');
    }

    // (d) complete en échec → rien de traité ; 2e scan relit ; 3 échecs → inbox non lu
    {
        const t = setup({
            list: () => [
                { id: 'f1', from: 'inconnu@ex.fr', subject: 'Bonjour' },
            ],
            replies: [
                new Error('LLM down'),
                new Error('LLM down'),
                new Error('LLM down'),
            ],
        });
        await t.courier.scan();
        assert.deepStrictEqual(t.courier.getState().processedIds, []);
        assert.strictEqual(t.courier.getState().readTries.f1, 1);
        assert.strictEqual(t.journal.size(), 0);
        await t.courier.scan();
        assert.strictEqual(t.prompts.length, 2);
        assert.deepStrictEqual(t.courier.getState().processedIds, []);
        // le compteur d'inconnus ne gonfle pas avec les relectures du même mail
        assert.strictEqual(t.courier.unknown()[0].count, 1);
        const r = await t.courier.scan();
        assert.strictEqual(t.prompts.length, READ_MAX_TRIES);
        assert.deepStrictEqual(t.courier.getState().processedIds, ['f1']);
        assert.strictEqual(t.courier.getState().readTries.f1, undefined);
        const d = t.journal.list(1)[0];
        assert.strictEqual(d.stage, 'inbox');
        assert.strictEqual(d.read, false);
        assert.strictEqual(r.inbox, 1);
        assert.strictEqual(r.read, 0);
    }

    // réponse illisible pour un seul mail du lot → seul ce mail reste à relire
    {
        const t = setup({
            list: () => [
                { id: 'p1', from: 'a@ex.fr', subject: 'A' },
                { id: 'p2', from: 'b@ex.fr', subject: 'B' },
            ],
            replies: ['[{"i":2,"notify":false}]'],
        });
        await t.courier.scan();
        assert.deepStrictEqual(t.courier.getState().processedIds, ['p2']);
        assert.strictEqual(t.courier.getState().readTries.p1, 1);
    }

    // gardé lu dont la lecture échoue : déjà archivé (hors in:inbox), relu quand même au poll suivant
    {
        let listed = true;
        const t = setup({
            list: (q) =>
                q.startsWith('in:inbox') && listed
                    ? [{ id: 'k1', from: 'x@qonto.com', subject: 'Contact' }]
                    : [],
            replies: [
                new Error('down'),
                '[{"i":1,"notify":true,"urgency":"soon"}]',
            ],
        });
        await t.courier.scan();
        listed = false;
        await t.courier.scan();
        assert.deepStrictEqual(t.courier.getState().processedIds, ['k1']);
        assert.strictEqual(t.notified.length, 1);
        assert.strictEqual(t.journal.list(1)[0].stage, 'keep');
        // rangé une seule fois sur les deux polls
        assert.deepStrictEqual(
            byTool(t.calls, 'modify_labels').map((c) => c.args),
            [{ messageId: 'k1', add: ['Boîtes/Qonto'], archive: true }],
        );
        assert.strictEqual(t.senders.keep()[0].hits, 1);
    }

    // inconnu en attente de lecture, devenu gardé avant la relecture → rangé quand même
    {
        const t = setup({
            list: () => [{ id: 'j1', from: 'boss@newco.fr', subject: 'Hello' }],
            replies: [new Error('down'), '[{"i":1,"notify":false}]'],
        });
        await t.courier.scan();
        assert.strictEqual(byTool(t.calls, 'modify_labels').length, 0);
        assert.strictEqual(t.courier.getState().pending?.j1?.kind, 'inbox');
        t.senders.upsertKeep(
            newKeepSender(
                { match: 'newco.fr', name: 'Newco', read: 'always' },
                NOW,
            ),
        );
        await t.courier.scan();
        assert.deepStrictEqual(
            byTool(t.calls, 'modify_labels').map((c) => c.args),
            [{ messageId: 'j1', add: ['Boîtes/Newco'], archive: true }],
        );
        const d = t.journal.list(1)[0];
        assert.strictEqual(d.stage, 'keep');
        assert.strictEqual(d.box, 'Newco');
        assert.deepStrictEqual(t.courier.getState().processedIds, ['j1']);
        assert.deepStrictEqual(t.courier.getState().pending, {});
    }

    // corps : échec get_email → snippet
    {
        const t = setup({
            list: () => [
                {
                    id: 'b1',
                    from: 'z@ex.fr',
                    subject: 'S',
                    snippet: 'SNIPPET-B1',
                },
            ],
            replies: ['[{"i":1,"notify":false}]'],
        });
        const orig = t.deps.deviceHandler;
        t.deps.deviceHandler = async (tool, args) => {
            if (tool === 'get_email') throw new Error('boom');
            return orig(tool, args);
        };
        await t.courier.scan();
        assert.ok(t.prompts[0].user.includes('SNIPPET-B1'));
    }

    // (e) sweep : trash_email pour chaque id ENCORE osef, journal trash, pas de 2e passage avant 24 h
    const SWEEP_Q = 'label:"Yui/Spam" older_than:15d -in:inbox';
    {
        const t = setup({
            list: (q) =>
                q === SWEEP_Q
                    ? [
                          { id: 'old1', from: 'a@promo.io', subject: 'x' },
                          { id: 'old2', from: 'b@promo.io', subject: 'y' },
                      ]
                    : [],
        });
        const n = await t.courier.sweep();
        assert.strictEqual(n, 2);
        const list = byTool(t.calls, 'list_messages_meta');
        assert.deepStrictEqual(list[0].args, {
            query: SWEEP_Q,
            maxResults: 50,
        });
        assert.deepStrictEqual(
            byTool(t.calls, 'trash_email').map((c) => c.args),
            [{ messageId: 'old1' }, { messageId: 'old2' }],
        );
        assert.strictEqual(t.journal.list(1)[0].stage, 'trash');
        assert.strictEqual(t.journal.size(), 2);
        assert.strictEqual(t.courier.getState().stats.trashed, 2);
        t.setNow(NOW + SWEEP_EVERY_MS - 1);
        assert.strictEqual(await t.courier.sweep(), 0);
        assert.strictEqual(byTool(t.calls, 'trash_email').length, 2);
        t.setNow(NOW + SWEEP_EVERY_MS);
        assert.strictEqual(await t.courier.sweep(), 2);
        // une erreur sur un mail est sautée
        t.setNow(NOW + 3 * SWEEP_EVERY_MS);
        const orig = t.deps.deviceHandler;
        t.deps.deviceHandler = async (tool, args) => {
            if (tool === 'trash_email' && args?.messageId === 'old1')
                throw new Error('nope');
            return orig(tool, args);
        };
        assert.strictEqual(await t.courier.sweep(), 1);
        const s = t.courier.stats(7);
        assert.strictEqual(s.trashed, 5);
        assert.strictEqual(s.byStage.trash, 5);
    }

    // sweep : le label seul ne suffit pas — un expéditeur passé « à garder »
    // ou retiré des listes n'est pas jeté, son Yui/Spam est retiré
    {
        const t = setup({
            list: (q) =>
                q === SWEEP_Q
                    ? [
                          { id: 's1', from: 'a@promo.io', subject: 'x' },
                          { id: 's2', from: 'b@qonto.com', subject: 'y' },
                          { id: 's3', from: 'c@ailleurs.fr', subject: 'z' },
                      ]
                    : [],
        });
        assert.strictEqual(await t.courier.sweep(), 1);
        assert.deepStrictEqual(
            byTool(t.calls, 'trash_email').map((c) => c.args),
            [{ messageId: 's1' }],
        );
        assert.deepStrictEqual(
            byTool(t.calls, 'modify_labels').map((c) => c.args),
            [
                { messageId: 's2', remove: [SPAM_LABEL] },
                { messageId: 's3', remove: [SPAM_LABEL] },
            ],
        );
        assert.strictEqual(t.journal.size(), 1);
        assert.strictEqual(t.courier.getState().stats.trashed, 1);
    }

    // (f) applySender : range rétroactivement, jamais de trash_email
    {
        const t = setup({
            list: (q) =>
                q === 'from:promo.io newer_than:90d' ||
                q === 'from:qonto.com newer_than:90d'
                    ? [
                          { id: 'r1', from: 'a@promo.io', subject: 'x' },
                          { id: 'r2', from: 'other@else.com', subject: 'y' },
                          { id: 'r3', from: 'b@qonto.com', subject: 'z' },
                      ]
                    : [],
        });
        // osef : refusé (400), aucun appel Gmail
        await assert.rejects(
            () => t.courier.applySender(t.spam.id),
            (e: unknown) =>
                e instanceof BadRequestError &&
                /expéditeurs à garder/.test(e.message),
        );
        assert.strictEqual(t.calls.length, 0);
        const kp = await t.courier.applySender(t.qonto.id, 30);
        assert.deepStrictEqual(kp, { matched: 1, applied: 1 });
        const lists = byTool(t.calls, 'list_messages_meta');
        assert.deepStrictEqual(lists[0].args, {
            query: 'from:qonto.com newer_than:90d',
            maxResults: 30,
        });
        assert.deepStrictEqual(
            byTool(t.calls, 'modify_labels').map((c) => c.args),
            [
                // gardé l'emporte sur osef : Yui/Spam retiré (sinon le balayage le jetterait)
                {
                    messageId: 'r3',
                    add: ['Boîtes/Qonto'],
                    remove: [SPAM_LABEL],
                    archive: true,
                },
            ],
        );
        assert.strictEqual(byTool(t.calls, 'trash_email').length, 0);
        await assert.rejects(
            () => t.courier.applySender('nope'),
            (e: unknown) => e instanceof NotFoundError,
        );
    }

    // dryRun : verdicts sans aucune écriture
    {
        const t = setup({
            list: () => [
                { id: 'd1', from: 'a@promo.io', subject: 'x' },
                { id: 'd2', from: 'b@qonto.com', subject: 'y' },
                { id: 'd3', from: 'c@ex.fr', subject: 'z' },
            ],
        });
        const out = await t.courier.dryRun();
        assert.deepStrictEqual(
            out.map((o) => o.verdict.kind),
            ['spam', 'keep', 'inbox'],
        );
        // défaut 100 = plafond réel de list_messages_meta côté GmailClient
        assert.strictEqual(t.calls[0].args.maxResults, 100);
        assert.deepStrictEqual(
            t.calls.map((c) => c.tool),
            ['list_messages_meta'],
        );
        assert.strictEqual(t.journal.size(), 0);
    }

    // (g) ordre satisfait → orders.fulfill
    {
        const t = setup({
            list: () => [
                { id: 'o1', from: 'michel@ex.fr', subject: 'Re: devis' },
            ],
            replies: [],
        });
        const order = t.orders.add(
            { text: 'Réponse de Michel', source: 'user' },
            NOW,
        );
        (t.deps as { complete: CourierDeps['complete'] }).complete = async (
            system,
        ) => {
            assert.ok(system.includes(order.id));
            return `[{"i":1,"notify":true,"reason":"Michel a répondu","orderId":"${order.id}","fulfilled":true}]`;
        };
        await t.courier.scan();
        const o = t.orders.all()[0];
        assert.strictEqual(o.state, 'fulfilled');
        assert.strictEqual(o.fulfilledBy, 'o1');
        assert.strictEqual(o.result, 'Michel a répondu');
        assert.strictEqual(t.journal.list(1)[0].orderId, order.id);
    }

    // (g2) ordre satisfait sans notify ni faits → onFulfilled quand même
    {
        const t = setup({
            list: () => [
                { id: 'o2', from: 'michel@ex.fr', subject: 'Re: devis' },
            ],
            replies: [],
        });
        const order = t.orders.add(
            { text: 'Réponse de Michel', source: 'user' },
            NOW,
        );
        const got: Array<{ mailId: string; text: string; state: string }> = [];
        t.deps.onFulfilled = (m, _item, o) =>
            got.push({ mailId: m.mailId, text: o.text, state: o.state });
        (t.deps as { complete: CourierDeps['complete'] }).complete = async () =>
            `[{"i":1,"notify":false,"reason":"Michel a répondu","orderId":"${order.id}","fulfilled":true}]`;
        await t.courier.scan();
        assert.deepStrictEqual(got, [
            { mailId: 'o2', text: 'Réponse de Michel', state: 'fulfilled' },
        ]);
        assert.strictEqual(t.notified.length, 0);
        assert.strictEqual(t.facts.length, 0);
    }

    // (h) 30 mails à lire → 24 lus (2 lots de 12), 6 reportés
    {
        const mails = Array.from({ length: 30 }, (_, i) => ({
            id: 'h' + i,
            from: `p${i}@ex.fr`,
            subject: 's' + i,
        }));
        const reply = JSON.stringify(
            Array.from({ length: 12 }, (_, i) => ({ i: i + 1, notify: false })),
        );
        const t = setup({ list: () => mails, replies: [reply, reply, reply] });
        const r = await t.courier.scan();
        assert.strictEqual(t.prompts.length, 2);
        assert.strictEqual(r.read, LLM_PER_POLL);
        assert.strictEqual(t.courier.getState().processedIds.length, 24);
        assert.strictEqual(byTool(t.calls, 'get_email').length, 24);
        const r2 = await t.courier.scan();
        assert.strictEqual(r2.read, 6);
        assert.strictEqual(t.courier.getState().processedIds.length, 30);
        const s = t.courier.stats(7);
        assert.strictEqual(s.total, 30);
        assert.strictEqual(s.read, 30);
        assert.strictEqual(s.byStage.inbox, 30);
    }

    // processedIds plafonné à 1000 (FIFO)
    {
        let batch = 0;
        const t = setup({
            keepRead: 'never',
            list: () =>
                Array.from({ length: 40 }, (_, i) => ({
                    id: `c${batch}-${i}`,
                    from: 'x@qonto.com',
                    subject: 's',
                })),
        });
        for (batch = 0; batch < 26; batch++) await t.courier.scan();
        const ids = t.courier.getState().processedIds;
        assert.strictEqual(ids.length, 1000);
        assert.strictEqual(ids[0], 'c1-0');
    }

    // scan unique : deux appels concurrents partagent la même exécution
    {
        const t = setup({
            list: () => [{ id: 'sf1', from: 'a@promo.io', subject: 'x' }],
        });
        const [a, b] = await Promise.all([t.courier.scan(), t.courier.scan()]);
        assert.strictEqual(a, b, 'même promesse, même résultat');
        assert.strictEqual(byTool(t.calls, 'list_messages_meta').length, 1);
        // terminé : le scan suivant repart
        await t.courier.scan();
        assert.strictEqual(byTool(t.calls, 'list_messages_meta').length, 2);
    }

    // erreurs MCP rendues en texte (« Error: … ») = échecs
    {
        // modify_labels en échec → non traité, retenté au poll suivant
        let failLabels = true;
        const t = setup({
            list: () => [{ id: 'e1', from: 'a@promo.io', subject: 'x' }],
        });
        const orig = t.deps.deviceHandler;
        t.deps.deviceHandler = async (tool, args) => {
            if (tool === 'modify_labels' && failLabels) {
                orig(tool, args); // tracé
                return 'Error: boom';
            }
            return orig(tool, args);
        };
        const r1 = await t.courier.scan();
        assert.strictEqual(r1.spammed, 0);
        assert.strictEqual(t.journal.size(), 0, 'rien de journalisé');
        assert.ok(!t.courier.getState().processedIds.includes('e1'));
        assert.strictEqual(t.senders.spam()[0].hits, 0, 'pas de hit compté');
        failLabels = false;
        const r2 = await t.courier.scan();
        assert.strictEqual(r2.spammed, 1);
        assert.ok(t.courier.getState().processedIds.includes('e1'));
        assert.strictEqual(byTool(t.calls, 'modify_labels').length, 2);
    }
    {
        // trash_email en échec → pas compté
        const t = setup({
            list: (q) =>
                q.startsWith('label:')
                    ? [{ id: 'e2', from: 'a@promo.io', subject: 'x' }]
                    : [],
        });
        const orig = t.deps.deviceHandler;
        t.deps.deviceHandler = async (tool, args) =>
            tool === 'trash_email' ? 'Erreur : quota' : orig(tool, args);
        assert.strictEqual(await t.courier.sweep(), 0);
        assert.strictEqual(t.courier.getState().stats.trashed, 0);
        assert.strictEqual(t.journal.size(), 0);
    }
    {
        // get_email en échec → l'extrait est lu à la place
        const t = setup({
            list: () => [
                {
                    id: 'e3',
                    from: 'x@inconnu.fr',
                    subject: 's',
                    snippet: 'SNIPPET-E3',
                },
            ],
            replies: [
                '[{"i":1,"notify":false,"urgency":"none","reason":"","facts":[]}]',
            ],
        });
        const orig = t.deps.deviceHandler;
        t.deps.deviceHandler = async (tool, args) =>
            tool === 'get_email' ? 'Error: boom' : orig(tool, args);
        await t.courier.scan();
        assert.ok(t.prompts[0].user.includes('SNIPPET-E3'));
        assert.ok(!t.prompts[0].user.includes('boom'));
    }
    {
        // corps vide après nettoyage → l'extrait
        const t = setup({
            list: () => [
                {
                    id: 'e5',
                    from: 'x@inconnu.fr',
                    subject: 's',
                    snippet: 'SNIPPET-E5',
                },
            ],
            replies: [
                '[{"i":1,"notify":false,"urgency":"none","reason":"","facts":[]}]',
            ],
        });
        const orig = t.deps.deviceHandler;
        t.deps.deviceHandler = async (tool, args) =>
            tool === 'get_email'
                ? 'From: x\n--- Corps ---\n   '
                : orig(tool, args);
        await t.courier.scan();
        assert.ok(t.prompts[0].user.includes('SNIPPET-E5'));
    }
    {
        // list_messages_meta en échec → erreur rapportée, rien n'est fait
        const t = setup({});
        t.deps.deviceHandler = async (tool, args = {}) => {
            t.calls.push({ tool, args });
            return 'Error: invalid_grant';
        };
        const r = await t.courier.scan();
        assert.ok(r.error && /invalid_grant/.test(r.error));
        assert.strictEqual(r.scanned, 0);
        assert.strictEqual(t.calls.length, 1);
        assert.strictEqual(t.courier.getState().lastScanAt, 0);
        assert.strictEqual(t.journal.size(), 0);
    }

    // inconnus de la migration posés dans la file, sans écraser l'existant
    {
        const t = setup({});
        assert.strictEqual(
            t.courier.seedUnknown([
                { match: 'News.Shop.com' },
                { match: 'bot@x.fr' },
            ]),
            2,
        );
        const u = t.courier
            .unknown()
            .find((x) => x.address === 'news.shop.com')!;
        assert.deepStrictEqual(
            { ...u, lastAt: 0 },
            {
                address: 'news.shop.com',
                from: 'News.Shop.com',
                count: 0,
                lastSubject: '',
                lastAt: 0,
                lastMailId: '',
                signal: 'quarantaine',
            },
        );
        assert.strictEqual(t.courier.seedUnknown([{ match: 'bot@x.fr' }]), 0);
        // relu depuis le disque
        const c2 = new MailCourier(t.deps, t.stateFile);
        assert.strictEqual(c2.unknown().length, 2);
    }

    // état illisible → repart à vide
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-bad-'));
        const f = path.join(dir, 'c.json');
        fs.writeFileSync(f, '{ nope');
        const t = setup({});
        const c = new MailCourier(t.deps, f);
        assert.strictEqual(c.getState().version, 3);
        assert.deepStrictEqual(c.getState().processedIds, []);
    }

    console.log('courier: all tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
