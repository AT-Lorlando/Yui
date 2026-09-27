import assert from 'assert';
import { collectFacts } from './facts';
import { selectFacts, momentRequiresSpeech, BRIEF_MAX_FACTS } from './select';
import type { Event } from '../events';
import type { Situation } from '../situation';

const T = new Date('2026-09-27T08:00:00').getTime();
const ev = (key: string, over: Partial<Event> = {}): Event => ({
    source: 'koya',
    key,
    kind: 'alert',
    importance: 'utile',
    subject: `Alerte ${key}`,
    facts: ['détail'],
    at: T - 1000,
    ...over,
});
const situation: Situation = {
    at: T,
    presence: 'home',
    lightsOn: [],
    doorLocked: false,
    agenda: [
        {
            title: 'Entretien Kinéis',
            date: '2026-09-27',
            start: '10:20',
            location: 'Toulouse',
        },
    ],
    parcels: [{ label: 'ASOS', status: 'out-for-delivery' }],
    mailActions: ['Renvoyer le RIB'],
    musicPlaying: false,
};

async function run(): Promise<void> {
    // Collecte : retenus + situation, sujets et natures.
    const facts = collectFacts(
        {
            momentKind: 'moment-wake',
            momentFacts: 'réveil',
            held: [ev('disk')],
            situation,
        },
        T,
    );
    const subjects = facts.map((f) => f.subject);
    assert.ok(subjects.includes('koya:disk'));
    assert.ok(
        subjects.includes('situation:agenda-today-2026-09-27-Entretien Kinéis'),
    );
    assert.ok(subjects.includes('situation:parcel-ASOS-out-for-delivery'));
    assert.ok(subjects.includes('situation:mail-Renvoyer le RIB'));
    assert.strictEqual(
        facts.find((f) => f.subject === 'koya:disk')!.heldKey,
        'koya:disk',
    );
    assert.strictEqual(
        facts.find((f) => f.subject.startsWith('situation:agenda'))!.nature,
        'agenda-today',
    );
    assert.ok(
        facts
            .find((f) => f.subject.startsWith('situation:agenda'))!
            .text.includes('Kinéis'),
    );
    // Importance uniforme des faits de situation : utile (quel que soit le type).
    assert.ok(
        facts
            .filter((f) => f.subject.startsWith('situation:'))
            .every((f) => f.importance === 'utile'),
        'faits de situation : importance utile',
    );
    // Scope par défaut (aucun scope précisé) : les trois catégories.
    assert.ok(subjects.some((s) => s.startsWith('situation:agenda')));
    assert.ok(subjects.some((s) => s.startsWith('situation:parcel')));
    assert.ok(subjects.some((s) => s.startsWith('situation:mail')));
    // Scope pending : pas d'agenda.
    const pending = collectFacts(
        {
            momentKind: 'on-demand',
            momentFacts: '',
            held: [],
            situation,
            scope: 'pending',
        },
        T,
    );
    assert.ok(!pending.some((f) => f.subject.startsWith('situation:agenda')));
    assert.ok(pending.some((f) => f.subject.startsWith('situation:mail')));
    // Scope today : agenda + colis, pas de mails.
    const today = collectFacts(
        {
            momentKind: 'on-demand',
            momentFacts: '',
            held: [],
            situation,
            scope: 'today',
        },
        T,
    );
    assert.ok(today.some((f) => f.subject.startsWith('situation:agenda')));
    assert.ok(today.some((f) => f.subject.startsWith('situation:parcel')));
    assert.ok(!today.some((f) => f.subject.startsWith('situation:mail')));

    // Sélection : mémoire, tri, plafond.
    const said = { isSaid: (s: string) => s === 'koya:disk' };
    const many = Array.from({ length: 12 }, (_, i) =>
        ev(`k${i}`, {
            importance: i === 11 ? 'urgent' : 'info',
            at: T - i * 1000,
        }),
    );
    const selected = selectFacts(
        collectFacts(
            {
                momentKind: 'moment-return',
                momentFacts: '',
                held: [ev('disk'), ...many],
                situation: null,
            },
            T,
        ),
        said,
        T,
    );
    assert.ok(
        !selected.some((f) => f.subject === 'koya:disk'),
        'déjà dit → exclu',
    );
    assert.strictEqual(selected.length, BRIEF_MAX_FACTS);
    assert.strictEqual(selected[0]!.subject, 'koya:k11', 'urgent en tête');
    assert.ok(selected[1]!.at <= selected[2]!.at, 'puis plus ancien d’abord');

    // Le moment impose-t-il de parler ?
    assert.strictEqual(
        momentRequiresSpeech('moment-bedtime', situation),
        true,
        'porte ouverte',
    );
    assert.strictEqual(
        momentRequiresSpeech('moment-bedtime', {
            ...situation,
            doorLocked: true,
        }),
        false,
    );
    assert.strictEqual(
        momentRequiresSpeech('moment-departure', situation),
        true,
    );
    assert.strictEqual(momentRequiresSpeech('moment-wake', situation), false);
    console.log('All select tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
