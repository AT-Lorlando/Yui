import assert from 'assert';
import {
    buildSecretaryPrompt,
    parseJudgment,
    eventsHash,
    type AgendaEvent,
} from './agendaSecretary';

const EVENTS: AgendaEvent[] = [
    {
        id: 'e1',
        title: 'Call Acme',
        date: '2026-06-25',
        start: '10:00',
        allDay: false,
        location: 'Visio',
        attendees: ['acme@x.com'],
    },
    {
        id: 'e2',
        title: 'Vacances',
        date: '2026-07-10',
        start: null,
        allDay: true,
        location: null,
        attendees: [],
    },
];
const NOW = new Date('2026-06-25T08:00:00Z');

async function run(): Promise<void> {
    // ── buildSecretaryPrompt ────────────────────────────────────────────────────
    {
        const { system, user } = buildSecretaryPrompt(EVENTS, NOW);
        assert.ok(/secr[ée]taire/i.test(system), 'system: rôle secrétaire');
        assert.ok(
            system.includes('meeting-pro') && system.includes('vacation'),
            'system: taxonomie',
        );
        assert.ok(/JSON/i.test(system), 'system: consigne JSON');
        assert.ok(
            user.includes('Call Acme') && user.includes('Vacances'),
            'user: events sérialisés',
        );
        assert.ok(user.includes('2026-06-25'), 'user: date présente');
    }

    // ── parseJudgment : JSON valide (même entouré de texte) ─────────────────────
    {
        const llm =
            'Voici:\n```json\n' +
            JSON.stringify({
                briefing: 'Call à 10h.',
                items: [
                    {
                        id: 'e1',
                        title: 'Call Acme',
                        date: '2026-06-25',
                        start: '10:00',
                        allDay: false,
                        location: 'Visio',
                        category: 'call',
                        categoryLabel: null,
                        importance: 80,
                        note: 'Relire le doc.',
                        detail: 'full',
                    },
                ],
                judgedAt: '2026-06-25T08:00:00.000Z',
            }) +
            '\n```\nVoilà.';
        const data = parseJudgment(llm);
        assert.ok(data, 'parse OK');
        assert.strictEqual(data!.briefing, 'Call à 10h.');
        assert.strictEqual(data!.items.length, 1);
        assert.strictEqual(data!.items[0].category, 'call');
        assert.strictEqual(data!.items[0].importance, 80);
    }

    // ── parseJudgment : normalisation (catégorie inconnue → autre, importance clampée) ─
    {
        const llm = JSON.stringify({
            briefing: 'x',
            items: [
                {
                    id: 'e9',
                    title: 'Truc',
                    date: '2026-06-25',
                    start: null,
                    allDay: true,
                    location: null,
                    category: 'licorne',
                    categoryLabel: null,
                    importance: 999,
                    note: null,
                    detail: 'wat',
                },
            ],
            judgedAt: '2026-06-25T08:00:00.000Z',
        });
        const data = parseJudgment(llm);
        assert.ok(data);
        assert.strictEqual(
            data!.items[0].category,
            'autre',
            'catégorie inconnue → autre',
        );
        assert.strictEqual(
            data!.items[0].categoryLabel,
            'licorne',
            'libellé libre conservé',
        );
        assert.strictEqual(
            data!.items[0].importance,
            100,
            'importance clampée à 100',
        );
        assert.strictEqual(
            data!.items[0].detail,
            'normal',
            'detail invalide → normal',
        );
    }

    // ── parseJudgment : JSON invalide / vide → null ─────────────────────────────
    {
        assert.strictEqual(parseJudgment('pas de json ici'), null);
        assert.strictEqual(parseJudgment(''), null);
        assert.strictEqual(parseJudgment('{ briefing: cassé'), null);
    }

    // ── eventsHash : stable et sensible au changement ───────────────────────────
    {
        const h1 = eventsHash(EVENTS);
        const h2 = eventsHash(EVENTS.slice());
        assert.strictEqual(h1, h2, 'hash stable pour même set');
        const changed = EVENTS.map((e, i) =>
            i === 0 ? { ...e, start: '11:00' } : e,
        );
        assert.notStrictEqual(
            h1,
            eventsHash(changed),
            'hash change si event change',
        );
    }

    console.log('agendaSecretary (pure units) OK');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
