import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Event } from '../events';
import type { Situation } from '../situation';
import type { PresenceState } from '../../presence';
import type { BriefInputs } from './facts';

// Aucun module ici ne doit toucher au vrai data/ : YUI_DATA_DIR est posé avant
// que les modules qui résolvent `dataPath` au chargement ne soient requis.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-composer-'));
process.env.YUI_DATA_DIR = tmp;
const { BriefComposer } = require('./composer') as typeof import('./composer');
const { SaidMemory } = require('../said') as typeof import('../said');
const { HeldQueue } = require('../held') as typeof import('../held');
const { ProactiveJournal } =
    require('../journal') as typeof import('../journal');
const { templateBrief } = require('./compose') as typeof import('./compose');
const { factsFingerprint } = require('../events') as typeof import('../events');

const T = new Date('2026-09-27T19:30:00').getTime();
const ev = (key: string, over: Partial<Event> = {}): Event => ({
    source: 'koya',
    key,
    kind: 'alert',
    importance: 'utile',
    subject: `Disque ${key} plein`,
    facts: ['92 % utilisés'],
    at: T - 60_000,
    ...over,
});
const situation = (over: Partial<Situation> = {}): Situation => ({
    at: T,
    presence: 'home',
    lightsOn: [],
    doorLocked: true,
    agenda: [],
    parcels: [],
    mailActions: [],
    musicPlaying: false,
    ...over,
});

interface Harness {
    composer: InstanceType<typeof BriefComposer>;
    said: InstanceType<typeof SaidMemory>;
    held: InstanceType<typeof HeldQueue>;
    journal: InstanceType<typeof ProactiveJournal>;
    calls: { complete: string[][]; notify: string[]; speak: string[] };
    presence: PresenceState;
    now: number;
}

let n = 0;
function harness(
    opts: {
        llm?: (system: string, user: string) => Promise<string>;
        presence?: PresenceState;
        llmTimeoutMs?: number;
    } = {},
): Harness {
    const calls = {
        complete: [] as string[][],
        notify: [] as string[],
        speak: [] as string[],
    };
    const h: Harness = {
        said: new SaidMemory(),
        held: new HeldQueue(),
        journal: new ProactiveJournal(path.join(tmp, `journal-${n++}.json`)),
        calls,
        presence: opts.presence ?? 'home',
        now: T,
        composer: null as unknown as InstanceType<typeof BriefComposer>,
    };
    h.composer = new BriefComposer({
        complete: async (system, user) => {
            calls.complete.push([system, user]);
            return opts.llm
                ? opts.llm(system, user)
                : 'Ton disque est plein, à 92 %.';
        },
        said: h.said,
        held: h.held,
        journal: h.journal,
        presence: () => h.presence,
        notify: async (t) => {
            calls.notify.push(t);
        },
        speak: async (t) => {
            calls.speak.push(t);
        },
        now: () => h.now,
        ...(opts.llmTimeoutMs !== undefined
            ? { llmTimeoutMs: opts.llmTimeoutMs }
            : {}),
    });
    return h;
}

function inputs(h: Harness, over: Partial<BriefInputs> = {}): BriefInputs {
    return {
        momentKind: 'moment-return',
        momentFacts: 'retour à la maison',
        held: h.held.peek(h.now),
        situation: situation(),
        ...over,
    };
}

async function run(): Promise<void> {
    // (a) Rien à dire au retour → silence : null, aucun LLM, aucune sortie.
    {
        const h = harness();
        const r = await h.composer.forMoment(inputs(h));
        assert.strictEqual(r, null);
        assert.strictEqual(h.calls.complete.length, 0);
        assert.strictEqual(h.calls.notify.length + h.calls.speak.length, 0);
        assert.strictEqual(h.journal.list().length, 0);
    }

    // (b) Un retenu, présent → LLM une fois, speak + notify, dit, retiré, journalisé.
    {
        const h = harness();
        h.held.add(ev('disk'), T - 60_000);
        h.held.add(ev('old', { subject: 'Disque old plein' }), T - 60_000);
        // « old » a déjà été dit : il ne doit ni sortir ni être retiré.
        h.said.markSaid(
            [
                {
                    subject: 'koya:old',
                    fingerprint: factsFingerprint(ev('old')),
                    nature: 'alert',
                },
            ],
            'speak',
            T - 3600_000,
        );
        assert.strictEqual(h.held.size(), 2);
        const r = await h.composer.forMoment(inputs(h));
        assert.ok(r, 'un fait à dire → résultat');
        assert.strictEqual(h.calls.complete.length, 1);
        assert.ok(
            h.calls.complete[0]![1].includes(
                '1. Disque disk plein — 92 % utilisés',
            ),
            'faits numérotés dans le prompt utilisateur',
        );
        assert.strictEqual(r.channel, 'speak');
        assert.strictEqual(r.text, 'Ton disque est plein, à 92 %.');
        assert.strictEqual(r.usedLlm, true);
        assert.strictEqual(r.fallback, false);
        assert.deepStrictEqual(r.subjects, ['koya:disk']);
        assert.deepStrictEqual(r.facts, ['Disque disk plein — 92 % utilisés']);
        assert.deepStrictEqual(h.calls.speak, [r.text]);
        assert.deepStrictEqual(h.calls.notify, [r.text]);
        assert.ok(
            h.said.isSaid('koya:disk', factsFingerprint(ev('disk')), T),
            'marqué dit',
        );
        assert.strictEqual(h.held.size(), 1, 'seul le fait dit est retiré');
        assert.strictEqual(h.held.peek(T)[0]!.key, 'old');
        const j = h.journal.list();
        assert.strictEqual(j.length, 1);
        assert.strictEqual(j[0]!.kind, 'moment');
        assert.strictEqual(j[0]!.source, 'moment-return');
        assert.strictEqual(j[0]!.subject, 'moment-return');
        assert.strictEqual(j[0]!.channel, 'speak');
        assert.strictEqual(j[0]!.message, r.text);
        assert.deepStrictEqual(j[0]!.facts, r.facts);
        assert.deepStrictEqual(j[0]!.subjects, r.subjects);
        // Les champs enrichis sont persistés (relecture du fichier).
        const j2 = new ProactiveJournal(path.join(tmp, 'journal-1.json'));
        assert.strictEqual(j2.list()[0]!.kind, 'moment');
        assert.deepStrictEqual(j2.list()[0]!.facts, r.facts);
        // Un point de moment ne consomme pas le budget des urgents.
        assert.strictEqual(h.journal.spentToday(T), 0);
        // Un second passage : plus rien à dire (déjà dit, retiré) → null.
        assert.strictEqual(await h.composer.forMoment(inputs(h)), null);
        assert.strictEqual(h.calls.complete.length, 1);
    }

    // (c) LLM qui invente → repli gabarité, fallback true, mais usedLlm true.
    {
        const h = harness({
            llm: async () => 'Tu as rendez-vous chez le Kiné à 10:20.',
        });
        h.held.add(ev('disk'), T - 60_000);
        const r = await h.composer.forMoment(inputs(h));
        assert.ok(r);
        assert.strictEqual(h.calls.complete.length, 1);
        assert.strictEqual(r.usedLlm, true);
        assert.strictEqual(r.fallback, true);
        assert.strictEqual(
            r.text,
            templateBrief('moment-return', [
                {
                    subject: 'koya:disk',
                    text: 'Disque disk plein — 92 % utilisés',
                    importance: 'utile',
                    at: T,
                    nature: 'alert',
                    fingerprint: 'x',
                },
            ]),
        );
        assert.deepStrictEqual(h.calls.speak, [r.text]);
        assert.ok(h.said.isSaid('koya:disk', factsFingerprint(ev('disk')), T));
        assert.strictEqual(h.held.size(), 0);
    }
    // (c') LLM qui lève → même repli.
    {
        const h = harness({
            llm: async () => {
                throw new Error('llm down');
            },
        });
        h.held.add(ev('disk'), T - 60_000);
        const r = await h.composer.forMoment(inputs(h));
        assert.ok(r);
        assert.strictEqual(r.usedLlm, true);
        assert.strictEqual(r.fallback, true);
        assert.ok(r.text.startsWith('Pendant ton absence :'));
    }
    // (c'') LLM qui ne répond jamais → borné par llmTimeoutMs → repli.
    {
        const h = harness({
            llm: () => new Promise<string>(() => undefined),
            llmTimeoutMs: 20,
        });
        h.held.add(ev('disk'), T - 60_000);
        const r = await h.composer.forMoment(inputs(h));
        assert.ok(r);
        assert.strictEqual(r.fallback, true);
        assert.deepStrictEqual(h.calls.speak, [r.text]);
    }

    // (d) Absent → notify seul.
    {
        const h = harness({ presence: 'away' });
        h.held.add(ev('disk'), T - 60_000);
        const r = await h.composer.forMoment(inputs(h));
        assert.ok(r);
        assert.strictEqual(r.channel, 'notify');
        assert.deepStrictEqual(h.calls.notify, [r.text]);
        assert.strictEqual(h.calls.speak.length, 0);
        assert.strictEqual(h.journal.list()[0]!.channel, 'notify');
        assert.strictEqual(h.journal.spentToday(T), 0);
    }

    // (e) Coucher : porte fermée sans fait → null ; porte ouverte → parle même sans retenu.
    {
        const h = harness();
        const locked = await h.composer.forMoment(
            inputs(h, {
                momentKind: 'moment-bedtime',
                momentFacts: 'lumières éteintes',
                situation: situation({ doorLocked: true }),
            }),
        );
        assert.strictEqual(locked, null);
        assert.strictEqual(h.calls.complete.length, 0);

        const h2 = harness({
            llm: async () => 'La porte n’est pas verrouillée.',
        });
        const open = await h2.composer.forMoment(
            inputs(h2, {
                momentKind: 'moment-bedtime',
                momentFacts:
                    'lumières éteintes ; la porte n’est pas verrouillée',
                situation: situation({ doorLocked: false }),
            }),
        );
        assert.ok(open, 'porte ouverte → non null même sans retenu');
        assert.strictEqual(
            open.channel,
            'speak',
            'anomalie de sécurité → parle',
        );
        assert.strictEqual(h2.calls.speak.length, 1);
        assert.ok(open.facts.length >= 1, 'la porte est un fait du point');
        assert.ok(
            /porte/i.test(open.facts.join(' ')),
            'le fait imposé parle de la porte',
        );

        // Coucher porte fermée avec matière → notify, même présent.
        const h3 = harness({ llm: async () => 'Un mail à traiter : « RIB ».' });
        const quiet = await h3.composer.forMoment(
            inputs(h3, {
                momentKind: 'moment-bedtime',
                momentFacts: 'lumières éteintes',
                situation: situation({
                    doorLocked: true,
                    mailActions: ['RIB'],
                }),
            }),
        );
        assert.ok(quiet);
        assert.strictEqual(quiet.channel, 'notify');
        assert.strictEqual(h3.calls.speak.length, 0);
        assert.deepStrictEqual(h3.calls.notify, [quiet.text]);
    }

    // (f) À la demande sans matière → jamais null, « Rien de nouveau » + compteurs,
    //     journal brief, cache 2 min par scope.
    {
        const h = harness();
        const sit = situation({
            mailActions: ['RIB', 'Facture'],
            parcels: [{ label: 'ASOS', status: 'en transit' }],
        });
        const base = inputs(h, {
            momentKind: 'on-demand',
            momentFacts: '',
            situation: sit,
            scope: 'since-last',
        });
        // Tout a déjà été dit → sélection vide.
        h.said.markSaid(
            h.composer.preview(base).map((f) => ({
                subject: f.subject,
                fingerprint: f.fingerprint,
                nature: f.nature,
            })),
            'speak',
            T - 1000,
        );
        assert.strictEqual(h.composer.preview(base).length, 0);
        const r = await h.composer.onDemand(base);
        assert.ok(r.text.length > 0);
        assert.ok(r.text.includes('Rien de nouveau'), r.text);
        assert.ok(r.text.includes('2 mails à traiter'), r.text);
        assert.ok(r.text.includes('1 colis en cours'), r.text);
        assert.strictEqual(r.channel, 'brief');
        assert.strictEqual(r.usedLlm, false);
        assert.strictEqual(h.calls.complete.length, 0);
        assert.strictEqual(h.calls.notify.length + h.calls.speak.length, 0);
        assert.strictEqual(h.journal.list().length, 1);
        assert.strictEqual(h.journal.list()[0]!.kind, 'brief');
        assert.strictEqual(h.journal.list()[0]!.channel, 'brief');
        assert.strictEqual(h.journal.spentToday(T), 0);

        // < 2 min, même scope → même résultat, ni LLM ni nouvelle entrée.
        h.now = T + 90_000;
        h.held.add(ev('disk'), h.now);
        const again = await h.composer.onDemand({
            ...base,
            held: h.held.peek(h.now),
        });
        assert.strictEqual(again.text, r.text);
        assert.strictEqual(h.calls.complete.length, 0);
        assert.strictEqual(h.journal.list().length, 1);
        assert.strictEqual(h.held.size(), 1, 'cache : rien retiré');

        // Autre scope → pas le cache : LLM appelé, retenu dit et retiré.
        const today = await h.composer.onDemand({
            ...base,
            scope: 'today',
            held: h.held.peek(h.now),
        });
        assert.strictEqual(h.calls.complete.length, 1);
        assert.strictEqual(today.channel, 'brief');
        assert.strictEqual(today.usedLlm, true);
        assert.deepStrictEqual(today.subjects, ['koya:disk']);
        assert.strictEqual(h.held.size(), 0, 'retenu dit → retiré');
        assert.strictEqual(h.calls.notify.length + h.calls.speak.length, 0);
        assert.strictEqual(h.journal.list().length, 2);

        // > 2 min → le cache du premier scope est périmé.
        h.now = T + 121_000;
        const later = await h.composer.onDemand({
            ...base,
            held: h.held.peek(h.now),
        });
        assert.notStrictEqual(later, r);
        assert.strictEqual(h.journal.list().length, 3);
    }

    // (g) preview : les faits qui sortiraient, sans LLM ni marquage.
    {
        const h = harness();
        h.held.add(ev('disk'), T - 60_000);
        const facts = h.composer.preview(inputs(h));
        assert.deepStrictEqual(
            facts.map((f) => f.subject),
            ['koya:disk'],
        );
        assert.strictEqual(h.calls.complete.length, 0);
        assert.strictEqual(h.said.size(), 0);
        assert.strictEqual(h.held.size(), 1);
        assert.strictEqual(h.journal.list().length, 0);
        // Deux aperçus d'affilée donnent la même chose.
        assert.deepStrictEqual(h.composer.preview(inputs(h)), facts);
    }

    console.log('All composer tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
