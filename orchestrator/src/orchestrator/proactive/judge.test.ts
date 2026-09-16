import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Judge, parseVerdict, buildJudgeUser } from './judge';
import { ProactiveJournal } from './journal';
import { isBrickEnabled, brickSetting } from './bricks';
import { detectMoments, returnMomentFacts } from './moments';
import type { MomentState } from './moments';
import { diffSituation } from './situation';
import type { Situation } from './situation';

const tmp = () =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-judge-')), 'j.json');

function situationAt(hour: number, over: Partial<Situation> = {}): Situation {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return {
        at: d.getTime(),
        presence: 'home',
        lightsOn: [],
        doorLocked: true,
        agenda: [],
        parcels: [],
        mailActions: [],
        musicPlaying: false,
        ...over,
    };
}

async function run(): Promise<void> {
    // ── parseVerdict : tolérant au bruit, strict sur le canal ─────────────
    assert.deepStrictEqual(
        parseVerdict('voilà : {"channel":"speak","message":"m","reason":"r"}'),
        { channel: 'speak', message: 'm', reason: 'r' },
    );
    assert.strictEqual(parseVerdict('{"channel":"yolo","message":"m"}'), null);
    assert.strictEqual(parseVerdict('pas de json'), null);

    // ── Budget : épuisé + non urgent → digest SANS appel LLM ─────────────
    const journal = new ProactiveJournal(tmp());
    const now = Date.now();
    journal.record({
        at: now,
        source: 'a',
        subject: 's1',
        channel: 'speak',
        message: 'x',
    });
    journal.record({
        at: now,
        source: 'a',
        subject: 's2',
        channel: 'speak',
        message: 'y',
    });
    let llmCalls = 0;
    const judge = new Judge({
        complete: async () => {
            llmCalls++;
            return '{"channel":"speak","message":"ok","reason":"r"}';
        },
        journal,
        budgetPerDay: () => 2,
        now: () => now,
    });
    const v1 = await judge.evaluate(
        {
            source: 'w',
            subject: 's3',
            facts: 'f',
            importance: 'utile',
            kind: 'event',
        },
        null,
        [],
    );
    assert.strictEqual(v1.channel, 'digest');
    assert.strictEqual(llmCalls, 0, 'budget épuisé → pas d’appel LLM');

    // Urgent passe malgré le budget ; moment exempté aussi.
    const v2 = await judge.evaluate(
        {
            source: 'w',
            subject: 's4',
            facts: 'f',
            importance: 'urgent',
            kind: 'event',
        },
        null,
        [],
    );
    assert.strictEqual(v2.channel, 'speak');
    const v3 = await judge.evaluate(
        {
            source: 'moment-wake',
            subject: 'moment-wake',
            facts: 'réveil',
            importance: 'utile',
            kind: 'moment',
            budgetExempt: true,
        },
        null,
        [],
    );
    assert.strictEqual(v3.channel, 'speak');
    assert.strictEqual(llmCalls, 2);

    // ── LLM en panne → repli par importance ───────────────────────────────
    const broken = new Judge({
        complete: async () => {
            throw new Error('down');
        },
        journal: new ProactiveJournal(tmp()),
        budgetPerDay: () => 3,
    });
    assert.strictEqual(
        (
            await broken.evaluate(
                {
                    source: 'w',
                    subject: 's',
                    facts: 'f',
                    importance: 'utile',
                    kind: 'event',
                },
                null,
                [],
            )
        ).channel,
        'notify',
    );
    assert.strictEqual(
        (
            await broken.evaluate(
                {
                    source: 'w',
                    subject: 's',
                    facts: 'f',
                    importance: 'info',
                    kind: 'event',
                },
                null,
                [],
            )
        ).channel,
        'digest',
    );

    // ── Le prompt embarque situation, deltas, budget et feedback ──────────
    const sit = situationAt(8, {
        agenda: [
            {
                title: 'Réunion',
                date: '2026-09-16',
                start: '11:00',
                location: null,
            },
        ],
    });
    journal.setFeedback(journal.list(1)[0]!.id, 'down');
    const user = buildJudgeUser(
        {
            source: 'weather',
            subject: 'pluie',
            facts: 'averse à 18h',
            importance: 'utile',
            kind: 'event',
        },
        sit,
        ['présence : away → home'],
        2,
        journal.recentSummary(now),
        journal.feedbackSummary(),
    );
    for (const needle of [
        'Réunion',
        'away → home',
        'BUDGET restant',
        '👎',
        'averse à 18h',
    ]) {
        assert.ok(user.includes(needle), `prompt sans « ${needle} »`);
    }

    // ── Journal : comptage du budget (speak=1, notify=0.5) ────────────────
    const j2 = new ProactiveJournal(tmp());
    j2.record({
        at: now,
        source: 'a',
        subject: 'x',
        channel: 'speak',
        message: 'm',
    });
    j2.record({
        at: now,
        source: 'a',
        subject: 'y',
        channel: 'notify',
        message: 'm',
    });
    j2.record({
        at: now,
        source: 'a',
        subject: 'z',
        channel: 'digest',
        message: 'm',
    });
    j2.record({
        at: now - 25 * 3600_000,
        source: 'a',
        subject: 'old',
        channel: 'speak',
        message: 'm',
    });
    assert.strictEqual(j2.spentToday(now), 1.5);

    // ── Briques : défauts + overrides + settings ──────────────────────────
    assert.strictEqual(isBrickEnabled({}, 'moment-wake'), true);
    assert.strictEqual(
        isBrickEnabled({}, 'irrigation-rain'),
        false,
        'plantes sous toit : off par défaut',
    );
    assert.strictEqual(
        isBrickEnabled(
            { bricks: { 'moment-wake': { enabled: false } } },
            'moment-wake',
        ),
        false,
    );
    assert.strictEqual(
        isBrickEnabled(
            { bricks: { 'irrigation-rain': { enabled: true } } },
            'irrigation-rain',
        ),
        true,
    );
    assert.strictEqual(
        brickSetting({ bricks: { x: { settings: { n: 5 } } } }, 'x', 'n', 1),
        5,
    );
    assert.strictEqual(brickSetting({}, 'x', 'n', 1), 1);

    // ── Moments : réveil une fois/jour, coucher, départ ───────────────────
    const st0: MomentState = { firedDepartures: [] };
    const morningOff = situationAt(7);
    const morningOn = situationAt(7, { lightsOn: ['Cuisine'] });
    const r1 = detectMoments(morningOff, morningOn, st0, () => true);
    assert.strictEqual(r1.moments[0]?.kind, 'moment-wake');
    const r2 = detectMoments(morningOff, morningOn, r1.state, () => true);
    assert.strictEqual(r2.moments.length, 0, 'un seul réveil par jour');
    // Brique off → rien.
    assert.strictEqual(
        detectMoments(morningOff, morningOn, st0, () => false).moments.length,
        0,
    );

    const eveningOn = situationAt(23, {
        lightsOn: ['Chambre'],
        doorLocked: false,
    });
    const eveningOff = situationAt(23, { doorLocked: false });
    const r3 = detectMoments(eveningOn, eveningOff, st0, () => true);
    assert.strictEqual(r3.moments[0]?.kind, 'moment-bedtime');
    assert.ok(r3.moments[0]!.facts.includes('pas verrouillée'));

    // Départ : event avec lieu dans ~30 min.
    const dep = situationAt(10);
    const in30 = new Date(dep.at + 30 * 60_000);
    const hh = `${String(in30.getHours()).padStart(2, '0')}:${String(
        in30.getMinutes(),
    ).padStart(2, '0')}`;
    const ymd = `${in30.getFullYear()}-${String(in30.getMonth() + 1).padStart(
        2,
        '0',
    )}-${String(in30.getDate()).padStart(2, '0')}`;
    const depNext = situationAt(10, {
        agenda: [
            { title: 'Dentiste', date: ymd, start: hh, location: 'Toulouse' },
        ],
    });
    const r4 = detectMoments(dep, depNext, st0, () => true);
    assert.strictEqual(r4.moments[0]?.kind, 'moment-departure');
    const r5 = detectMoments(dep, depNext, r4.state, () => true);
    assert.strictEqual(r5.moments.length, 0, 'un rappel par événement');

    // ── Retour : facts composés depuis la situation ───────────────────────
    const facts = returnMomentFacts(
        situationAt(18, {
            parcels: [{ label: 'chaussures ASOS', status: 'delivered' }],
            mailActions: ['Relance impôts'],
        }),
    );
    assert.ok(facts.includes('chaussures ASOS'));
    assert.ok(facts.includes('1 mail'));

    // ── Deltas de situation ───────────────────────────────────────────────
    const d = diffSituation(
        situationAt(9, { parcels: [{ label: 'colis A', status: 'shipped' }] }),
        situationAt(9, {
            parcels: [{ label: 'colis A', status: 'delivered' }],
            mailActions: ['Facture EDF'],
        }),
    );
    assert.ok(d.some((x) => x.includes('colis A')));
    assert.ok(d.some((x) => x.includes('Facture EDF')));

    console.log('All judge/bricks/moments tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
