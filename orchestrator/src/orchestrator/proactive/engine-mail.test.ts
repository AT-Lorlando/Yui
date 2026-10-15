// Intégration moteur + courrier v3 : migration des règles v2 au démarrage,
// alerte immédiate d'un mail lu (notifyMail) relayée au connecteur, ordres
// satisfaits (attentes poussées tout de suite), watch_for et résumé du
// dashboard.
import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// Même contrainte que engine-postits.test.ts : YUI_DATA_DIR posé AVANT que
// les modules ne résolvent leurs dataPath() au chargement.
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-em-'));
const { dataPath } = require('@yui/shared') as typeof import('@yui/shared');
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');
const { SaidMemory } = require('./said') as typeof import('./said');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');
const { PostitRegistry } = require('./postits') as typeof import('./postits');

const tmpFile = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-em-')), name);

const NOW = new Date('2026-09-28T09:00:00').getTime();

function cfg(): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
        budgetPerDay: 3,
    };
}

async function run(): Promise<void> {
    // ── Migration au démarrage : mail-rules.json → mail-senders.json ─────
    const rulesFile = dataPath('mail-rules.json');
    fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
    const rule = (id: string, from: string, category: string | null) => ({
        id,
        when: { from },
        then: { category },
        origin: 'user',
        confirmed: true,
        hits: 0,
        createdAt: 1000,
    });
    fs.writeFileSync(
        rulesFile,
        JSON.stringify({
            version: 1,
            rules: [
                rule('r1', 'qonto.com', 'finance'),
                rule('r2', 'promo.shop.com', 'promo'),
                rule('r3', 'ami.fr', null),
            ],
        }),
    );

    let now = NOW;
    let presence: PresenceState = 'home';
    const notified: string[] = [];
    const spoken: string[] = [];
    const deps: ProactiveDeps = {
        complete: async () => '{"channel":"skip","reason":"test"}',
        notify: async (t) => {
            notified.push(t);
        },
        speak: async (t) => {
            spoken.push(t);
        },
        presenceState: () => presence,
        subscribePresence: () => () => {},
        deviceHandler: async () => null,
        runScene: async () => ({ success: true }),
        now: () => now,
    };
    const journal = new ProactiveJournal(tmpFile('journal.json'));
    const build = () =>
        new ProactiveEngine(cfg(), deps, {
            dedup: new Dedup(),
            journal,
            held: new HeldQueue(),
            said: new SaidMemory(),
            postits: new PostitRegistry(tmpFile('postits.json')),
        });
    const engine = build();

    assert.ok(fs.existsSync(dataPath('mail-senders.json')), 'listes écrites');
    assert.ok(!fs.existsSync(rulesFile), 'mail-rules.json renommé');
    const bak = path.join(path.dirname(rulesFile), 'mail-rules.v2.bak.json');
    assert.ok(fs.existsSync(bak), 'sauvegarde v2 gardée');
    assert.deepStrictEqual(
        engine.mailSenders.keep().map((k) => k.match),
        ['qonto.com'],
    );
    assert.deepStrictEqual(
        engine.mailSenders.spam().map((s) => s.match),
        ['promo.shop.com'],
    );
    const report = JSON.parse(
        fs.readFileSync(dataPath('mail-migration.json'), 'utf-8'),
    );
    assert.strictEqual(report.keep, 1);
    assert.strictEqual(report.spam, 1);
    assert.strictEqual(report.dropped, 1);

    // Un second démarrage ne remigre rien (listes déjà là, même si un
    // mail-rules.json réapparaît).
    fs.writeFileSync(rulesFile, JSON.stringify({ version: 1, rules: [] }));
    const again = build();
    assert.strictEqual(again.mailSenders.keep().length, 1);
    assert.ok(fs.existsSync(rulesFile), 'rien renommé au second démarrage');

    // ── notifyMail : sortie immédiate + journal + file du connecteur ─────
    const ref = {
        mailId: 'm1',
        from: '"Michel Dupont" <michel@exemple.fr>',
        subject: 'Devis cuisine',
    };
    const item = {
        notify: true,
        urgency: 'now' as const,
        reason: 'Michel répond à ta demande de devis',
        facts: ['Devis : 1 240 €'],
    };
    await engine.notifyMail(ref, item);
    const text =
        'Courrier : « Devis cuisine » de Michel Dupont — Michel répond à ta demande de devis';
    assert.deepStrictEqual(notified, [text]);
    assert.deepStrictEqual(spoken, [text], 'présent, hors nuit → parlé');
    const entry = journal.list(1)[0]!;
    assert.strictEqual(entry.source, 'mail-reader');
    assert.strictEqual(entry.reason, item.reason);
    assert.strictEqual(entry.channel, 'speak');
    assert.strictEqual(entry.subject, 'm1');

    // Absent → notification seule ; la nuit → notification seule.
    presence = 'away' as PresenceState;
    await engine.notifyMail({ ...ref, mailId: 'm2' }, item);
    presence = 'home';
    now = new Date('2026-09-28T02:00:00').getTime();
    await engine.notifyMail({ ...ref, mailId: 'm3' }, item);
    now = NOW;
    assert.strictEqual(notified.length, 3);
    assert.strictEqual(spoken.length, 1);

    // Les trois mails attendent le connecteur, qui vide la file.
    const taken = engine.takeMailNotified();
    assert.deepStrictEqual(
        taken.map((n) => n.mailId),
        ['m1', 'm2', 'm3'],
    );
    assert.strictEqual(taken[0]!.item.reason, item.reason);
    assert.deepStrictEqual(engine.takeMailNotified(), [], 'file vidée');

    // ── Plafond quotidien des sorties immédiates (5/jour) ────────────────
    // m1–m3 déjà poussés aujourd'hui ; m4, m5 encore ; m6 refusé.
    await engine.notifyMail({ ...ref, mailId: 'm4' }, item);
    await engine.notifyMail({ ...ref, mailId: 'm5' }, item);
    assert.strictEqual(notified.length, 5);
    await engine.notifyMail({ ...ref, mailId: 'm6' }, item);
    assert.strictEqual(notified.length, 5, '6e mail du jour : aucune sortie');
    const capped = engine.takeMailNotified();
    assert.deepStrictEqual(
        capped.map((n) => [n.mailId, n.capped === true]),
        [
            ['m4', false],
            ['m5', false],
            ['m6', true],
        ],
        'le mail plafonné reste en file, marqué',
    );
    assert.strictEqual(journal.list(1)[0]!.channel, 'hold');
    assert.strictEqual(journal.list(1)[0]!.subject, 'm6');
    // Les suivants du jour : comptés, en file, mais plus de nouvelle entrée.
    const journalSize = journal.list(300).length;
    await engine.notifyMail({ ...ref, mailId: 'm6b' }, item);
    assert.strictEqual(notified.length, 5);
    assert.strictEqual(
        journal.list(300).length,
        journalSize,
        'un seul « plafonnée » par jour au journal',
    );
    assert.deepStrictEqual(
        engine.takeMailNotified().map((n) => [n.mailId, n.capped === true]),
        [['m6b', true]],
    );

    // Le plafond survit au redémarrage (relu du journal) …
    const restarted = build();
    await restarted.notifyMail({ ...ref, mailId: 'm7' }, item);
    assert.strictEqual(notified.length, 5, 'plafond relu après redémarrage');
    assert.strictEqual(
        journal.list(300).length,
        journalSize,
        'entrée « plafonnée » du jour relue après redémarrage',
    );
    // … et repart le lendemain.
    now = NOW + 86_400_000;
    await restarted.notifyMail({ ...ref, mailId: 'm8' }, item);
    assert.strictEqual(notified.length, 6, 'nouveau jour, nouvelle sortie');
    now = NOW;

    // Appels concurrents (un lot du lecteur) : le plafond est réservé
    // avant tout await.
    const burst = build();
    now = NOW + 2 * 86_400_000;
    await Promise.all(
        Array.from({ length: 7 }, (_, i) =>
            burst.notifyMail({ ...ref, mailId: `b${i}` }, item),
        ),
    );
    assert.strictEqual(notified.length, 11, '5 sorties sur 7 mails simultanés');
    now = NOW;

    // ── Ordre de connecteur satisfait → file du connecteur (inchangé) ────
    const before = notified.length;
    const viaQueue = engine.mailOrderFulfilled(
        { mailId: 'm9', from: 'Michel <m@x.fr>', subject: 'Re: devis' },
        { ...item, notify: false, facts: [] },
        {
            id: 'o-1',
            text: 'Colis Amazon',
            createdAt: NOW,
            expiresAt: NOW,
            source: 'connector',
            origin: 'parcel:p1',
            state: 'fulfilled',
        },
    );
    assert.strictEqual(viaQueue, false, 'le facteur garde son chemin');
    assert.deepStrictEqual(
        engine.takeMailFulfilled().map((n) => [n.mailId, n.order]),
        [['m9', { id: 'o-1', text: 'Colis Amazon' }]],
    );
    assert.deepStrictEqual(engine.takeMailFulfilled(), []);
    assert.strictEqual(notified.length, before, 'aucune sortie immédiate');

    // ── watch_for : attente à la voix + ordre courrier lié ───────────────
    const reply = await engine.watchFor({
        what: 'Réponse de Michel sur le devis',
        keywords: ['Michel', 'devis'],
        days: 14,
    });
    assert.strictEqual(
        reply,
        "D'accord, je te préviens dès que ça arrive, jusqu'au 12/10.",
    );
    const order = engine.mailOrders.active(NOW)[0]!;
    assert.strictEqual(order.text, 'Réponse de Michel sur le devis');
    assert.strictEqual(order.source, 'voice');
    const w = engine.watches.active(NOW)[0]!;
    assert.strictEqual(order.origin, `watch:${w.id}`);

    // ── Ordre voix satisfait → sortie immédiate unique, hors plafond ─────
    // Le plafond du jour est déjà atteint (m1–m5) : une attente satisfaite
    // passe quand même, c'est une demande explicite.
    const flush = () => new Promise((r) => setImmediate(r));
    const pushed = engine.mailOrderFulfilled(
        {
            mailId: 'm10',
            from: '"Michel Dupont" <michel@exemple.fr>',
            subject: 'Re: devis cuisine',
        },
        { ...item, notify: true },
        { ...order, state: 'fulfilled' },
    );
    await flush();
    assert.strictEqual(pushed, true, 'le facteur ne repousse pas ce mail');
    const expected =
        'Ce que tu attendais : Réponse de Michel sur le devis. Re: devis cuisine, de Michel Dupont';
    assert.deepStrictEqual(notified.slice(before), [expected], 'une sortie');
    assert.strictEqual(spoken[spoken.length - 1], expected, 'présent → parlé');
    const hit = journal.list(1)[0]!;
    assert.strictEqual(hit.source, 'mail');
    assert.strictEqual(hit.subject, `mail-order-${order.id}`);
    assert.strictEqual(hit.reason, 'attente : Réponse de Michel sur le devis');
    assert.strictEqual(hit.kind, 'event');
    assert.strictEqual(hit.requested, true, 'hors budget du juge');
    assert.strictEqual(hit.channel, 'speak');
    assert.deepStrictEqual(engine.takeMailFulfilled(), [], 'pas de file');
    assert.deepStrictEqual(engine.takeMailNotified(), [], 'pas de notifyMail');
    const done = engine.watches.find(w.id)!;
    assert.strictEqual(done.state, 'fulfilled');
    assert.strictEqual(done.matchedKey, `mail-order-${order.id}`);
    assert.strictEqual(done.matchedSubject, 'Re: devis cuisine');

    // Ordre posé depuis /mail (source user, sans attente) : même sortie.
    const userPushed = engine.mailOrderFulfilled(
        { mailId: 'm11', from: 'a@b.fr', subject: 'Offre' },
        { ...item, notify: false, facts: [] },
        {
            id: 'o-u',
            text: 'Offre DevOps',
            createdAt: NOW,
            expiresAt: NOW,
            source: 'user',
            state: 'fulfilled',
        },
    );
    await flush();
    assert.strictEqual(userPushed, true);
    assert.strictEqual(
        notified[notified.length - 1],
        'Ce que tu attendais : Offre DevOps. Offre, de a@b.fr',
    );
    assert.deepStrictEqual(engine.takeMailFulfilled(), []);

    // Sortie en échec (notify rejette) : entrée de journal quand même,
    // attente laissée active, aucun rejet non géré.
    const w2Reply = await engine.watchFor({
        what: 'Réponse du notaire',
        keywords: ['notaire'],
        days: 7,
    });
    assert.ok(w2Reply.startsWith("D'accord"));
    const w2 = engine.watches
        .active(NOW)
        .find((x) => x.text === 'Réponse du notaire')!;
    const o2 = engine.mailOrders
        .active(NOW)
        .find((o) => o.origin === `watch:${w2.id}`)!;
    const realNotify = deps.notify;
    deps.notify = async () => {
        throw new Error('FCM down');
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const failedPush = engine.mailOrderFulfilled(
        { mailId: 'm12', from: 'notaire@etude.fr', subject: 'Acte' },
        { ...item, notify: true },
        { ...o2, state: 'fulfilled' },
    );
    await flush();
    await flush();
    process.off('unhandledRejection', onUnhandled);
    deps.notify = realNotify;
    assert.strictEqual(failedPush, true);
    assert.deepStrictEqual(unhandled, [], 'aucun rejet non géré');
    const failEntry = journal.list(1)[0]!;
    assert.strictEqual(failEntry.subject, `mail-order-${o2.id}`);
    assert.strictEqual(failEntry.channel, 'notify');
    assert.strictEqual(
        failEntry.reason,
        'attente : Réponse du notaire — sortie en échec : FCM down',
    );
    assert.strictEqual(engine.watches.find(w2.id)!.state, 'active');
    engine.watchRemove(w2.id);

    // L'ordre lié satisfait n'est plus actif.
    engine.mailOrders.fulfill(order.id, 'm10', 'ok', NOW);

    // ── Résumé du dashboard ──────────────────────────────────────────────
    const summary = engine.getTriageSummary();
    assert.strictEqual(summary.ordersCount, 0);
    assert.strictEqual(summary.unknownCount, 0);
    assert.strictEqual(summary.pendingCount, 0);

    // ── Erreur MCP (isError) : le facteur la voit comme un échec ─────────
    const toolCalls: string[] = [];
    deps.callToolWithStatus = async (tool) => {
        toolCalls.push(tool);
        return { result: 'invalid_grant', isError: true };
    };
    const failed = await engine.courier.scan();
    assert.strictEqual(failed.error, 'invalid_grant');
    assert.deepStrictEqual(toolCalls, ['list_messages_meta']);
    delete deps.callToolWithStatus;

    console.log('All engine-mail tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
