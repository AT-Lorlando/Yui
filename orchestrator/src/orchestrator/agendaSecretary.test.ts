import assert from 'assert';
import {
    buildSecretaryPrompt,
    parseJudgment,
    eventsHash,
    fetchAgendaEvents,
    AgendaSecretary,
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

    // ── fetchAgendaEvents : normalise get_schedule ──────────────────────────────
    {
        const calls: any[] = [];
        const callTool = async (name: string, args?: any) => {
            calls.push({ name, args });
            return {
                start: '2026-06-25',
                end: '2026-08-24',
                days: [
                    {
                        date: '2026-06-25',
                        events: [
                            {
                                id: 'e1',
                                title: 'Call Acme',
                                date: '2026-06-25',
                                all_day: false,
                                start: '10:00',
                                location: 'Visio',
                                attendees: ['acme@x.com'],
                            },
                        ],
                    },
                    {
                        date: '2026-07-10',
                        events: [
                            {
                                id: 'e2',
                                title: 'Vacances',
                                date: '2026-07-10',
                                all_day: true,
                                location: null,
                            },
                        ],
                    },
                ],
            };
        };
        const evs = await fetchAgendaEvents(
            callTool,
            new Date('2026-06-25T08:00:00Z'),
        );
        assert.strictEqual(calls[0].name, 'get_schedule');
        assert.strictEqual(calls[0].args.startDate, '2026-06-25');
        assert.strictEqual(
            calls[0].args.endDate,
            '2026-08-24',
            'endDate = +60 j',
        );
        assert.strictEqual(evs.length, 2);
        assert.deepStrictEqual(evs[0].attendees, ['acme@x.com']);
        assert.strictEqual(evs[1].allDay, true);
        assert.deepStrictEqual(evs[1].attendees, [], 'attendees absents → []');
    }

    // ── AgendaSecretary : cache + null-sans-cache ───────────────────────────────
    {
        const SCHED = {
            days: [
                {
                    date: '2026-06-25',
                    events: [
                        {
                            id: 'e1',
                            title: 'Call',
                            date: '2026-06-25',
                            all_day: false,
                            start: '10:00',
                        },
                    ],
                },
            ],
        };
        let completeCalls = 0;
        const okJudgment = JSON.stringify({
            briefing: 'b',
            items: [
                {
                    id: 'e1',
                    title: 'Call',
                    date: '2026-06-25',
                    start: '10:00',
                    allDay: false,
                    location: null,
                    category: 'call',
                    categoryLabel: null,
                    importance: 70,
                    note: null,
                    detail: 'full',
                },
            ],
            judgedAt: '2026-06-25T08:00:00.000Z',
        });

        // cas nominal + cache
        {
            const sec = new AgendaSecretary({
                callTool: async () => SCHED,
                complete: async () => {
                    completeCalls++;
                    return okJudgment;
                },
                ttlMs: 60_000,
            });
            const now = new Date('2026-06-25T08:00:00Z');
            const a = await sec.getAgenda(now);
            assert.ok(a && a.items[0].category === 'call');
            assert.strictEqual(completeCalls, 1);
            await sec.getAgenda(new Date('2026-06-25T08:00:30Z')); // même events, dans le TTL
            assert.strictEqual(completeCalls, 1, 'cache: pas de 2e appel LLM');
        }

        // échec LLM → null, pas de mise en cache (retry)
        {
            let n = 0;
            const sec = new AgendaSecretary({
                callTool: async () => SCHED,
                complete: async () => {
                    n++;
                    throw new Error('llm down');
                },
            });
            assert.strictEqual(
                await sec.getAgenda(new Date('2026-06-25T08:00:00Z')),
                null,
            );
            assert.strictEqual(
                await sec.getAgenda(new Date('2026-06-25T08:00:01Z')),
                null,
            );
            assert.strictEqual(n, 2, 'échec non caché → re-tenté');
        }
    }

    console.log('agendaSecretary (pure units) OK');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
