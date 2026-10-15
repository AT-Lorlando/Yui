// Décisions manuelles (`decide`) : sur un retenu ou une entrée de journal,
// texte déterministe, sortie forcée pour `speak`, journal `manual` avec
// l'événement, retrait de la file, dédup et mémoire « dit ».
import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { Event } from './events';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// Comme engine-judge.test.ts : YUI_DATA_DIR avant le chargement des modules.
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ed-'));
const { ProactiveEngine, DecisionNotFound, DecisionExpired } =
    require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');
const { SaidMemory } = require('./said') as typeof import('./said');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');
const { factsFingerprint } = require('./events') as typeof import('./events');

const tmpFile = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ed-')), name);

const HOUR = 3600_000;
// 02:00 : en pleine heure de silence (23:00–07:00).
const NOW = new Date('2026-09-16T02:00:00').getTime();

function cfg(): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        digestTime: '07:00',
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
        budgetPerDay: 3,
    };
}

function ev(key: string, over: Partial<Event> = {}): Event {
    return {
        source: 'koya',
        key,
        kind: 'alert',
        importance: 'utile',
        subject: `Sujet ${key}`,
        facts: [`Fait ${key}`, 'second fait'],
        at: NOW - HOUR,
        ...over,
    };
}

function harness(presence: PresenceState = 'home') {
    const notified: string[] = [];
    const spoken: string[] = [];
    let llm = 0;
    const deps: ProactiveDeps = {
        complete: async () => {
            llm++;
            return '';
        },
        notify: async (t) => void notified.push(t),
        speak: async (t) => void spoken.push(t),
        presenceState: () => presence,
        subscribePresence: () => () => {},
        deviceHandler: async () => null,
        runScene: async () => ({ success: true }),
        now: () => NOW,
    };
    const journal = new ProactiveJournal(tmpFile('journal.json'));
    const held = new HeldQueue();
    const dedup = new Dedup();
    const said = new SaidMemory();
    const engine = new ProactiveEngine(cfg(), deps, {
        dedup,
        journal,
        held,
        said,
    });
    return {
        engine,
        journal,
        held,
        dedup,
        said,
        notified,
        spoken,
        llm: () => llm,
    };
}

async function rejects(p: Promise<unknown>, cls: Function): Promise<void> {
    try {
        await p;
    } catch (err) {
        assert.ok(err instanceof cls, `attendu ${cls.name}, reçu ${err}`);
        return;
    }
    assert.fail(`attendu ${cls.name}, aucune erreur`);
}

async function run(): Promise<void> {
    // ── speak sur un retenu, présent, la nuit → parole forcée ─────────────
    {
        const h = harness();
        const e = ev('disk');
        h.held.add(e, NOW);
        const out = await h.engine.decide({ held: 'koya:disk' }, 'speak');
        const msg = 'Sujet disk. Fait disk';
        assert.deepStrictEqual(out, { channel: 'speak', message: msg });
        assert.deepStrictEqual(h.notified, [msg], 'notification toujours');
        assert.deepStrictEqual(h.spoken, [msg], 'parole forcée la nuit');
        assert.strictEqual(h.llm(), 0, 'sans LLM');
        const [entry] = h.journal.list(10);
        assert.ok(entry);
        assert.strictEqual(entry.manual, true);
        assert.strictEqual(entry.channel, 'speak');
        assert.strictEqual(entry.subject, 'disk');
        assert.strictEqual(entry.source, 'koya');
        assert.strictEqual(entry.kind, 'event');
        assert.strictEqual(entry.reason, 'décision manuelle');
        assert.deepStrictEqual(entry.event, e);
        assert.strictEqual(h.held.size(), 0, 'retiré de la file');
        assert.strictEqual(h.dedup.lastMessage('koya:disk'), msg);
        assert.ok(
            h.dedup.isDuplicate('koya:disk', NOW, HOUR, factsFingerprint(e)),
            'dédup posé',
        );
        assert.ok(
            h.said.isSaid('koya:disk', factsFingerprint(e), NOW),
            'marqué dit',
        );
        assert.strictEqual(h.said.list()[0]!.nature, 'alert');
        assert.strictEqual(h.journal.manualSummary(NOW), '[koya] disk → speak');
    }

    // ── notify → notification seule ; template prioritaire ; marqueur ───
    {
        const h = harness();
        h.held.add(
            ev('cal', { facts: ['nature:agenda-far', 'Mardi 10h'] }),
            NOW,
        );
        h.held.add(ev('tpl', { template: 'Texte tout prêt.' }), NOW);
        const a = await h.engine.decide({ held: 'koya:cal' }, 'notify');
        assert.strictEqual(a.message, 'Sujet cal. Mardi 10h', 'marqueur ôté');
        const b = await h.engine.decide({ held: 'koya:tpl' }, 'notify');
        assert.strictEqual(b.message, 'Texte tout prêt.');
        assert.deepStrictEqual(h.notified, [a.message, b.message]);
        assert.deepStrictEqual(h.spoken, [], 'notify → pas de parole');
        assert.strictEqual(h.held.size(), 0);
        const cal = h.said.list().find((s) => s.subject === 'koya:cal');
        assert.strictEqual(cal?.nature, 'agenda-far', 'nature du marqueur');
    }

    // ── skip → rien d'émis, retiré, pas marqué dit ──────────────────────
    {
        const h = harness();
        const e = ev('noise', { facts: [] });
        h.held.add(e, NOW);
        const out = await h.engine.decide({ held: 'koya:noise' }, 'skip');
        assert.deepStrictEqual(out, {
            channel: 'skip',
            message: 'Sujet noise',
        });
        assert.deepStrictEqual(h.notified, []);
        assert.deepStrictEqual(h.spoken, []);
        assert.strictEqual(h.held.size(), 0);
        assert.strictEqual(h.said.size(), 0, 'skip ne marque pas dit');
        assert.strictEqual(h.journal.list(1)[0]!.channel, 'skip');
        assert.strictEqual(h.journal.list(1)[0]!.manual, true);
        assert.strictEqual(h.dedup.lastMessage('koya:noise'), 'Sujet noise');
    }

    // ── inconnu / trop ancien ────────────────────────────────────────────
    {
        const h = harness();
        await rejects(
            h.engine.decide({ held: 'koya:nope' }, 'speak'),
            DecisionNotFound,
        );
        await rejects(
            h.engine.decide({ journal: 'nope' }, 'speak'),
            DecisionNotFound,
        );
        // Entrée de journal sans événement (moment, mail…) → introuvable.
        const bare = h.journal.record({
            at: NOW,
            source: 'moment-wake',
            subject: 'wake',
            channel: 'speak',
            message: 'm',
        });
        await rejects(
            h.engine.decide({ journal: bare.id }, 'notify'),
            DecisionNotFound,
        );
        const old = h.journal.record({
            at: NOW - 49 * HOUR,
            source: 'koya',
            subject: 'old',
            channel: 'skip',
            message: 'm',
            event: ev('old', { at: NOW - 49 * HOUR }),
        });
        await rejects(
            h.engine.decide({ journal: old.id }, 'speak'),
            DecisionExpired,
        );
        assert.deepStrictEqual(h.notified, []);
    }

    // ── depuis une entrée de journal `skip` : rejoue, ne touche pas la file
    {
        const h = harness();
        const e = ev('lost', { importance: 'urgent' });
        // Même clé en file : la décision depuis le journal la retire aussi.
        h.held.add(e, NOW);
        const entry = h.journal.record({
            at: NOW - HOUR,
            source: 'koya',
            subject: 'lost',
            channel: 'skip',
            message: 'jugé sans intérêt',
            event: e,
        });
        const out = await h.engine.decide({ journal: entry.id }, 'notify');
        assert.strictEqual(out.message, 'Sujet lost. Fait lost');
        assert.deepStrictEqual(h.notified, [out.message]);
        assert.strictEqual(h.held.size(), 0, 'retenu de même clé retiré');
        assert.strictEqual(h.journal.list(1)[0]!.manual, true);
        assert.ok(h.said.isSaid('koya:lost', factsFingerprint(e), NOW));
    }

    // ── skip depuis le journal, événement encore en file → retiré ────────
    {
        const h = harness();
        const e = ev('ignored');
        h.held.add(e, NOW);
        h.held.add(ev('other'), NOW);
        const entry = h.journal.record({
            at: NOW - HOUR,
            source: 'koya',
            subject: 'ignored',
            channel: 'skip',
            message: 'm',
            event: e,
        });
        await h.engine.decide({ journal: entry.id }, 'skip');
        assert.deepStrictEqual(
            h.engine.heldList().map((x) => x.key),
            ['other'],
            'seul le retenu de même clé est retiré',
        );
        assert.strictEqual(h.said.size(), 0);
    }

    // ── speak demandé, Jérémy absent → notification seule, canal effectif ─
    {
        const h = harness('away');
        const e = ev('away');
        h.held.add(e, NOW);
        const out = await h.engine.decide({ held: 'koya:away' }, 'speak');
        assert.strictEqual(out.channel, 'notify', 'canal effectif rendu');
        assert.deepStrictEqual(h.notified, [out.message]);
        assert.deepStrictEqual(h.spoken, [], 'pas de parole absent');
        assert.strictEqual(h.journal.list(1)[0]!.channel, 'notify');
        const said = h.said.list().find((x) => x.subject === 'koya:away');
        assert.ok(said, 'marqué dit');
        assert.strictEqual(
            h.journal.manualSummary(NOW),
            '[koya] away → notify',
        );
    }

    // ── les verdicts du juge et les critiques journalisent leur événement ─
    {
        const h = harness();
        const crit = ev('down', { importance: 'critique' });
        await h.engine.ingest(crit);
        const [entry] = h.journal.list(1);
        assert.ok(entry, 'critique journalisé');
        assert.deepStrictEqual(entry.event, crit);
    }

    console.log('All engine-decide tests passed');
}

run().catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
});
