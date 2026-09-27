import assert from 'assert';
import { collectFacts } from './facts';
import type { BriefInputs } from './facts';
import type { Event } from '../events';
import { factsFingerprint } from '../events';
import type { Situation } from '../situation';
import { postitLine } from '../postits';

const T = new Date('2026-09-27T21:00:00').getTime();
const ev = (key: string, over: Partial<Event> = {}): Event => ({
    source: 'calendar',
    key,
    kind: 'info',
    importance: 'utile',
    subject: `Sujet ${key}`,
    facts: [],
    at: T - 1000,
    ...over,
});
const situation: Situation = {
    at: T,
    presence: 'home',
    lightsOn: [],
    doorLocked: true,
    agenda: [],
    parcels: [],
    mailActions: [],
    musicPlaying: false,
    sections: {
        yoji: [
            { label: 'Post-it', value: 'Renvoyer le RIB (2 j)', key: 'a' },
            { label: 'Post-it ancien', value: 'Vieux truc (12 j)', key: 'b' },
        ],
        calendar: [
            { label: 'Agenda', value: 'Kinéis à 10:20' },
            {
                label: 'Demain tôt',
                value: '« Train » à 07:30',
                importance: 'utile',
            },
        ],
        weather: [{ label: 'Météo', value: '20°C à Toulouse' }],
    },
};
const inputs = (over: Partial<BriefInputs> = {}): BriefInputs => ({
    momentKind: 'on-demand',
    momentFacts: '',
    held: [],
    situation,
    ...over,
});

async function run(): Promise<void> {
    // ── Marqueur `nature:` en tête des facts d'un retenu ──────────────────
    const far = ev('agenda-1-new', { facts: ['nature:agenda-far'] });
    const [farFact] = collectFacts(inputs({ held: [far], situation: null }), T);
    assert.strictEqual(farFact!.nature, 'agenda-far');
    assert.strictEqual(farFact!.text, 'Sujet agenda-1-new', 'marqueur exclu');
    assert.strictEqual(farFact!.heldKey, 'calendar:agenda-1-new');
    assert.strictEqual(farFact!.fingerprint, factsFingerprint(far));

    const withDetail = ev('x', { facts: ['nature:postit-stale', 'détail'] });
    const [detailFact] = collectFacts(
        inputs({ held: [withDetail], situation: null }),
        T,
    );
    assert.strictEqual(detailFact!.nature, 'postit-stale');
    assert.strictEqual(detailFact!.text, 'Sujet x — détail');

    // Marqueur inconnu ou mal placé : mapping kind→nature, ligne conservée.
    const bogus = ev('y', { kind: 'alert', facts: ['nature:bogus'] });
    const [bogusFact] = collectFacts(
        inputs({ held: [bogus], situation: null }),
        T,
    );
    assert.strictEqual(bogusFact!.nature, 'alert');
    assert.strictEqual(bogusFact!.text, 'Sujet y — nature:bogus');
    const second = ev('z', { kind: 'request', facts: ['a', 'nature:info'] });
    const [secondFact] = collectFacts(
        inputs({ held: [second], situation: null }),
        T,
    );
    assert.strictEqual(secondFact!.nature, 'request');
    assert.strictEqual(secondFact!.text, 'Sujet z — a ; nature:info');

    // La ligne du post-it est dite mais n'entre pas dans l'empreinte : la
    // réémission (sans la ligne) de la même origine est reconnue comme dite.
    const bare = ev('todo', { facts: ['nature:request', 'détail'] });
    const withLine = ev('todo', {
        facts: ['nature:request', 'détail', postitLine('Faire todo')],
    });
    const [bareFact] = collectFacts(
        inputs({ held: [bare], situation: null }),
        T,
    );
    const [lineFact] = collectFacts(
        inputs({ held: [withLine], situation: null }),
        T,
    );
    assert.strictEqual(lineFact!.fingerprint, bareFact!.fingerprint);
    assert.strictEqual(
        lineFact!.text,
        "Sujet todo — détail ; Je t'ai mis un post-it : « Faire todo »",
    );
    assert.strictEqual(bareFact!.text, 'Sujet todo — détail');
    assert.strictEqual(lineFact!.nature, 'request', 'le marqueur reste lu');
    assert.notStrictEqual(
        bareFact!.fingerprint,
        collectFacts(
            inputs({
                held: [ev('todo', { facts: ['détail'] })],
                situation: null,
            }),
            T,
        )[0]!.fingerprint,
        'le marqueur nature: compte toujours dans l’empreinte',
    );

    // ── Sections de situation → faits de brief ───────────────────────────
    const all = collectFacts(inputs(), T);
    const stale = all.find((f) => f.subject === 'postit:b-stale');
    assert.ok(stale, 'post-it ancien → fait de brief');
    assert.strictEqual(stale!.text, 'Post-it qui traîne : Vieux truc (12 j)');
    assert.strictEqual(stale!.nature, 'postit-stale');
    assert.strictEqual(stale!.importance, 'utile');
    assert.strictEqual(stale!.at, T);
    assert.strictEqual(stale!.heldKey, undefined);
    const early = all.find(
        (f) => f.subject === 'situation:agenda-early-« Train » à 07:30',
    );
    assert.ok(early, 'demain tôt → fait de brief');
    assert.strictEqual(early!.text, 'Demain tôt : « Train » à 07:30');
    assert.strictEqual(early!.nature, 'agenda-today');
    assert.strictEqual(early!.importance, 'utile');
    // Un post-it courant, l'agenda du jour et la météo restent de la situation.
    assert.ok(!all.some((f) => f.text.includes('Renvoyer le RIB')));
    assert.ok(!all.some((f) => f.text.includes('Kinéis')));
    assert.ok(!all.some((f) => f.text.includes('Toulouse')));

    // Scopes : ancien = since-last + pending ; demain tôt = since-last + today.
    const since = collectFacts(inputs({ scope: 'since-last' }), T);
    assert.ok(since.some((f) => f.subject === 'postit:b-stale'));
    assert.ok(
        since.some((f) => f.subject.startsWith('situation:agenda-early')),
    );
    const today = collectFacts(inputs({ scope: 'today' }), T);
    assert.ok(!today.some((f) => f.subject === 'postit:b-stale'));
    assert.ok(
        today.some((f) => f.subject.startsWith('situation:agenda-early')),
    );
    const pending = collectFacts(inputs({ scope: 'pending' }), T);
    assert.ok(pending.some((f) => f.subject === 'postit:b-stale'));
    assert.ok(
        !pending.some((f) => f.subject.startsWith('situation:agenda-early')),
    );

    // Sans sections (situation d'avant les connecteurs) : rien ne casse.
    assert.doesNotThrow(() =>
        collectFacts(
            inputs({ situation: { ...situation, sections: undefined } }),
            T,
        ),
    );
    // Sans clé : la valeur sert d'identité (jamais de sujet vide).
    const keyless = collectFacts(
        inputs({
            situation: {
                ...situation,
                sections: {
                    yoji: [
                        { label: 'Post-it ancien', value: 'Sans clé (9 j)' },
                    ],
                },
            },
        }),
        T,
    );
    assert.strictEqual(keyless[0]!.subject, 'postit:Sans clé (9 j)-stale');

    console.log('All facts tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
