import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// ConnectorState/OrderStore résolvent dataPath() : isoler YUI_DATA_DIR AVANT
// de charger les modules.
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-mailc-'));
const { mailConnector } = require('./mail') as typeof import('./mail');
const { ConnectorState } =
    require('../connectorState') as typeof import('../connectorState');
import type { ConnectorContext } from '../connector';
import type { FulfilledNotice, MailNotice } from './mail';
import type { MailOrder } from '../mail/orders';

const NOW = new Date('2026-10-14T10:00:00').getTime();
const DAY = 86_400_000;

function notice(
    id: string,
    urgency: 'none' | 'soon' | 'now',
    extra: Partial<MailNotice['item']> = {},
): MailNotice {
    return {
        mailId: id,
        from: 'Michel Dupont <michel@exemple.fr>',
        subject: `Devis ${id}`,
        item: {
            notify: true,
            urgency,
            reason: 'Michel répond à ta demande de devis',
            facts: ['Devis : 1 240 €'],
            ...extra,
        },
    };
}

async function run(): Promise<void> {
    const now = NOW;
    let scans = 0;
    let sweeps = 0;
    let notified: MailNotice[] = [];
    let factsQ: MailNotice[] = [];
    let fulfilledQ: FulfilledNotice[] = [];
    let unknownList: Array<{ address: string }> = [];
    let orders: MailOrder[] = [];

    const c = mailConnector({
        courier: {
            scan: async () => {
                scans++;
                return {};
            },
            sweep: async () => {
                sweeps++;
                return 0;
            },
            unknown: () => unknownList,
        },
        orders: { active: () => orders },
        takeNotified: () => notified.splice(0),
        takeFacts: () => factsQ.splice(0),
        takeFulfilled: () => fulfilledQ.splice(0),
    });

    // Réglages : poll 15 min et plafond horaire, plus de `query` ni `triage`.
    const keys = (c.settings ?? []).map((s) => s.key).sort();
    assert.deepStrictEqual(keys, ['maxPerHour', 'pollMinutes']);
    assert.strictEqual(c.pollMinutes, 15);

    const state = new ConnectorState();
    const ctx: ConnectorContext = {
        callTool: async () => null,
        settings: { pollMinutes: 15, maxPerHour: 6 },
        state,
        presence: () => 'home',
        now: () => now,
        log: { info: () => {}, warn: () => {} },
    };

    // ── Rien à drainer : scan + balayage quand même, aucun événement ─────
    assert.deepStrictEqual(await c.events!(ctx), []);
    assert.strictEqual(scans, 1, 'scan à chaque poll');
    assert.strictEqual(
        sweeps,
        1,
        'balayage à chaque poll (borné par le courier)',
    );

    // ── notify → toujours utile (la sortie immédiate du moteur est LE
    // canal d'alerte : le juge ne doit pas pousser une seconde fois) ──────
    notified = [
        notice('m1', 'now'),
        notice('m2', 'soon'),
        { ...notice('m3', 'now'), capped: true },
    ];
    const evs = await c.events!(ctx);
    assert.strictEqual(evs.length, 3);
    assert.deepStrictEqual(
        evs.map((e) => e.importance),
        ['utile', 'utile', 'utile'],
        'jamais urgent, même en urgency now',
    );
    const e1 = evs[0]!;
    assert.strictEqual(e1.source, 'mail');
    assert.strictEqual(e1.key, 'mail-notify-m1');
    assert.strictEqual(e1.kind, 'request');
    assert.strictEqual(e1.subject, 'Mail — Michel Dupont : « Devis m1 »');
    assert.deepStrictEqual(e1.facts, [
        'Michel répond à ta demande de devis',
        'Devis : 1 240 €',
    ]);
    assert.strictEqual(e1.at, NOW);
    assert.strictEqual(e1.ttlMs, 7 * DAY);
    assert.deepStrictEqual(e1.todo, {
        title: 'Répondre : Devis m1',
        description:
            'De Michel Dupont <michel@exemple.fr> — gmail:m1 — Michel répond à ta demande de devis',
    });
    assert.ok(
        !e1.facts.some((f) => f.includes('plafonnée')),
        'pas de mention de plafond sans plafond',
    );
    assert.ok(
        evs[2]!.facts.includes("Notification plafonnée pour aujourd'hui"),
        'mail non poussé (plafond) : événement émis avec le fait',
    );
    assert.ok(evs[2]!.todo, 'le post-it reste posé');

    // Sujet borné à SUBJECT_MAX, une ligne.
    notified = [
        {
            ...notice('m7', 'none'),
            subject: 'Très\nlong ' + 'x'.repeat(400),
        },
    ];
    const long = (await c.events!(ctx))[0]!;
    assert.ok(long.subject.length <= 200);
    assert.ok(!long.subject.includes('\n'));
    assert.ok(long.todo!.title.length <= 120);

    // ── facts → événement info retenu ────────────────────────────────────
    factsQ = [
        {
            mailId: 'm8',
            from: 'Qonto <noreply@qonto.com>',
            subject: 'Relevé de septembre',
            item: {
                notify: false,
                urgency: 'none',
                reason: 'Relevé mensuel',
                facts: ['Solde : 3 200 €', 'Frais : 9 €'],
            },
        },
    ];
    const infos = await c.events!(ctx);
    assert.strictEqual(infos.length, 1);
    const info = infos[0]!;
    assert.strictEqual(info.key, 'mail-info-m8');
    assert.strictEqual(info.kind, 'info');
    assert.strictEqual(info.importance, 'info');
    assert.strictEqual(info.subject, 'Courrier : « Relevé de septembre »');
    assert.deepStrictEqual(info.facts, ['Solde : 3 200 €', 'Frais : 9 €']);
    assert.strictEqual(info.ttlMs, 3 * DAY);
    assert.strictEqual(info.todo, undefined);

    // ── ordre satisfait → événement info, même sans faits ────────────────
    fulfilledQ = [
        {
            mailId: 'm9',
            from: 'Michel <michel@exemple.fr>',
            subject: 'Re: devis',
            item: {
                notify: false,
                urgency: 'none',
                reason: 'Michel a répondu',
                orderId: 'o-3',
                fulfilled: true,
                facts: [],
            },
            order: { id: 'o-3', text: 'Réponse de Michel sur le devis' },
        },
    ];
    const done = await c.events!(ctx);
    assert.strictEqual(done.length, 1);
    assert.strictEqual(done[0]!.key, 'mail-order-o-3');
    assert.strictEqual(done[0]!.kind, 'info');
    assert.strictEqual(done[0]!.importance, 'info');
    assert.strictEqual(
        done[0]!.subject,
        'Ordre satisfait : Réponse de Michel sur le devis',
    );
    assert.deepStrictEqual(done[0]!.facts, ['Michel a répondu']);
    assert.strictEqual(done[0]!.ttlMs, 3 * DAY);

    // ── snapshot : inconnus + ordres actifs (≤ 5) ────────────────────────
    assert.deepStrictEqual(await c.snapshot!(ctx), [], 'rien à dire');
    unknownList = [{ address: 'a@x.fr' }, { address: 'b@y.fr' }];
    orders = Array.from({ length: 7 }, (_, i) => ({
        id: `o-${i}`,
        text: `Ordre ${i}`,
        createdAt: NOW,
        expiresAt: NOW + 14 * DAY,
        source: 'user' as const,
        state: 'active' as const,
    }));
    const snap = await c.snapshot!(ctx);
    assert.deepStrictEqual(snap[0], {
        label: 'Courrier',
        value: '2 expéditeur(s) inconnu(s)',
    });
    const waits = snap.filter((f) => f.label === 'J’attends');
    assert.strictEqual(waits.length, 5);
    assert.strictEqual(waits[0]!.value, 'Ordre 0');

    console.log('All mail connector tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
