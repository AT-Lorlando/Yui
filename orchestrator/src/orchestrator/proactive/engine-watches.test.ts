// Attentes côté moteur : `watchAdd` crée l'ordre courrier lié, un événement
// qui satisfait l'attente est poussé tout de suite (notification, parole si
// présent et hors nuit), journalisé, et retire l'ordre lié ; `watchRemove`
// retire aussi l'ordre.
import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { Event } from './events';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// Comme engine-decide.test.ts : YUI_DATA_DIR avant le chargement des modules
// (OrderStore et consorts lisent `dataPath`).
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ew-'));
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');
const { SaidMemory } = require('./said') as typeof import('./said');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');
const { WatchStore } = require('./watches') as typeof import('./watches');

const tmpFile = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ew-')), name);

const DAY = 86_400_000;
const DAYTIME = new Date('2026-10-15T14:00:00').getTime();
const NIGHT = new Date('2026-10-16T02:00:00').getTime();

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

function ev(key: string, at: number, over: Partial<Event> = {}): Event {
    return {
        source: 'mail',
        key,
        kind: 'info',
        importance: 'info',
        subject: 'Réponse de Michel au sujet du devis',
        facts: ['Pièce jointe : devis.pdf'],
        at,
        ...over,
    };
}

function harness(presence: PresenceState, now: number) {
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
        now: () => now,
    };
    const journal = new ProactiveJournal(tmpFile('journal.json'));
    const held = new HeldQueue();
    const watches = new WatchStore(tmpFile('watches.json'));
    const engine = new ProactiveEngine(cfg(), deps, {
        dedup: new Dedup(),
        journal,
        held,
        said: new SaidMemory(),
        watches,
    });
    // Les ordres courrier sont partagés via YUI_DATA_DIR : on repart vide.
    for (const o of [...engine.mailOrders.all()])
        engine.mailOrders.remove(o.id);
    return {
        engine,
        journal,
        held,
        watches,
        notified,
        spoken,
        llm: () => llm,
    };
}

async function run(): Promise<void> {
    // ── watchAdd sans source → ordre courrier lié ────────────────────
    {
        const h = harness('home', DAYTIME);
        const w = h.engine.watchAdd({
            what: 'la réponse de Michel',
            keywords: ['michel'],
            days: 10,
            origin: 'app',
        });
        assert.ok(w.mailOrderId, 'ordre lié renseigné');
        const o = h.engine.mailOrders.all().find((x) => x.id === w.mailOrderId);
        assert.ok(o);
        assert.strictEqual(o.text, 'la réponse de Michel');
        assert.strictEqual(o.source, 'user');
        assert.strictEqual(o.origin, `watch:${w.id}`);
        assert.strictEqual(o.expiresAt, DAYTIME + 10 * DAY);
        assert.strictEqual(
            h.watches.find(w.id)?.mailOrderId,
            o.id,
            'persisté dans le store',
        );
        // Vue : l'attente et l'ordre (pas ceux des connecteurs).
        h.engine.mailOrders.add(
            { text: 'colis', source: 'connector', origin: 'parcel:1' },
            DAYTIME,
        );
        const view = h.engine.watchesView();
        assert.deepStrictEqual(
            view.watches.map((x) => x.id),
            [w.id],
        );
        assert.deepStrictEqual(
            view.orders.map((x) => x.id),
            [o.id],
        );

        // Source 'mail' explicite → ordre aussi ; autre source → pas d'ordre.
        const wm = h.engine.watchAdd({
            what: 'facture EDF',
            source: 'mail',
            keywords: ['edf'],
            origin: 'voice',
        });
        assert.ok(wm.mailOrderId);
        assert.strictEqual(
            h.engine.mailOrders.all().find((x) => x.id === wm.mailOrderId)
                ?.source,
            'voice',
        );
        const wd = h.engine.watchAdd({
            what: 'le colis Amazon',
            source: 'deliveries',
            keywords: ['amazon'],
            origin: 'app',
        });
        assert.strictEqual(wd.mailOrderId, undefined);

        // Validation : erreur du store, rien de créé.
        const before = h.engine.mailOrders.all().length;
        assert.throws(
            () =>
                h.engine.watchAdd({
                    what: 'abc',
                    keywords: ['x'],
                    origin: 'app',
                }),
            /texte/,
        );
        assert.strictEqual(h.engine.mailOrders.all().length, before);

        // ── watchRemove retire l'ordre lié ───────────────────────────
        assert.ok(h.engine.watchRemove(w.id));
        assert.strictEqual(h.watches.find(w.id), undefined);
        assert.ok(
            !h.engine.mailOrders.all().some((x) => x.id === w.mailOrderId),
            'ordre lié retiré',
        );
        assert.ok(!h.engine.watchRemove(w.id), 'inconnue → false');
    }

    // ── Attente satisfaite, présent, de jour → notification + parole ──
    {
        const h = harness('home', DAYTIME);
        const w = h.engine.watchAdd({
            what: 'la réponse de Michel',
            keywords: ['michel', 'devis'],
            origin: 'app',
        });
        // Un seul mot-clé sur deux : rien.
        assert.strictEqual(
            await h.engine.ingest(
                ev('m-0', DAYTIME, { subject: 'Michel', facts: [] }),
            ),
            'accepted',
        );
        assert.deepStrictEqual(h.notified, [], 'pas de push sans match');
        assert.strictEqual(h.watches.find(w.id)?.state, 'active');

        assert.strictEqual(
            await h.engine.ingest(ev('m-1', DAYTIME)),
            'accepted',
        );
        const text =
            'Ce que tu attendais : la réponse de Michel. Réponse de Michel au sujet du devis';
        assert.deepStrictEqual(h.notified, [text]);
        assert.deepStrictEqual(h.spoken, [text], 'parole : présent, de jour');
        assert.strictEqual(h.llm(), 0, 'sans LLM');
        const entry = h.journal
            .list(10)
            .find((x) => x.reason === 'attente : la réponse de Michel');
        assert.ok(entry, 'journal « attente : … »');
        assert.strictEqual(entry.channel, 'speak');
        assert.strictEqual(entry.subject, 'm-1');
        assert.strictEqual(entry.source, 'mail');
        assert.strictEqual(entry.message, text);
        assert.strictEqual(entry.event?.key, 'm-1');
        const done = h.watches.find(w.id);
        assert.strictEqual(done?.state, 'fulfilled');
        assert.strictEqual(done?.matchedKey, 'm-1');
        assert.strictEqual(done?.fulfilledAt, DAYTIME);
        assert.ok(
            !h.engine.mailOrders.all().some((x) => x.id === w.mailOrderId),
            'ordre courrier lié retiré',
        );
        assert.deepStrictEqual(
            h.held.peek(DAYTIME).map((x) => x.key),
            ['m-0'],
            "m-1 pas retenu (m-0, info sans attente, l'est)",
        );
        // Satisfaite : un second événement ne repousse rien (dédup + état).
        await h.engine.ingest(ev('m-2', DAYTIME));
        assert.strictEqual(h.notified.length, 1);
    }

    // ── La nuit, présent → notification seule (pas un critique) ───────
    {
        const h = harness('home', NIGHT);
        const w = h.engine.watchAdd({
            what: 'le colis Amazon',
            source: 'deliveries',
            keywords: ['amazon'],
            origin: 'app',
        });
        const out = await h.engine.ingest(
            ev('p-1', NIGHT, {
                source: 'deliveries',
                subject: 'Colis Amazon livré',
                facts: [],
            }),
        );
        assert.strictEqual(out, 'accepted', 'court-circuite la nuit');
        assert.deepStrictEqual(h.notified, [
            'Ce que tu attendais : le colis Amazon. Colis Amazon livré',
        ]);
        assert.deepStrictEqual(h.spoken, [], 'pas de parole la nuit');
        assert.strictEqual(h.held.size(), 0);
        assert.strictEqual(h.watches.find(w.id)?.state, 'fulfilled');
        const [entry] = h.journal.list(1);
        assert.strictEqual(entry?.channel, 'notify');
    }

    // ── Absent, de jour → notification seule ─────────────────────────
    {
        const h = harness('away', DAYTIME);
        h.engine.watchAdd({
            what: 'la réponse de Michel',
            keywords: ['michel'],
            origin: 'app',
        });
        await h.engine.ingest(ev('m-1', DAYTIME));
        assert.strictEqual(h.notified.length, 1);
        assert.deepStrictEqual(h.spoken, [], 'absent : pas de parole');
    }

    console.log('All engine-watches tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
