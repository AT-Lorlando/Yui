import assert from 'assert';
import {
    buildSecretaryPrompt,
    categorizeEvent,
    checkText,
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
        endDate: null,
        durationMin: 60,
        start: '10:00',
        allDay: false,
        location: 'Visio',
        description: null,
        attendees: ['acme@x.com'],
    },
    {
        id: 'e2',
        title: 'Vacances',
        date: '2026-07-10',
        endDate: '2026-07-24',
        durationMin: null,
        start: null,
        allDay: true,
        location: null,
        description: 'Chez Bastien à Lyon',
        attendees: [],
    },
];
const NOW = new Date('2026-06-25T08:00:00Z');

function ev(partial: Partial<AgendaEvent> & { title: string }): AgendaEvent {
    return {
        id: partial.title,
        date: '2026-07-01',
        endDate: null,
        durationMin: 60,
        start: '10:00',
        allDay: false,
        location: null,
        description: null,
        attendees: [],
        ...partial,
    };
}

async function run(): Promise<void> {
    // ── categorizeEvent : règles déterministes ──────────────────────────────────
    {
        const cat = (e: AgendaEvent) => categorizeEvent(e, NOW);

        assert.deepStrictEqual(
            cat(ev({ title: 'Entretien Kinéis' })),
            { category: 'meeting-pro', sure: false },
            'Kinéis ne matche pas kiné (frontière de mot) → meeting-pro incertain',
        );
        assert.deepStrictEqual(
            cat(ev({ title: 'Kiné', start: '18:00' })),
            { category: 'perso', sure: true },
            'kiné seul → perso sûr',
        );
        assert.deepStrictEqual(
            cat(ev({ title: 'Psy', start: '18:00' })),
            { category: 'perso', sure: true },
            'Psy → perso sûr',
        );
        assert.deepStrictEqual(
            cat(
                ev({
                    title: 'Vacances Bretagne',
                    date: '2026-08-01',
                    endDate: '2026-08-08',
                    allDay: true,
                    start: null,
                    durationMin: null,
                }),
            ),
            { category: 'vacation', sure: true },
            'Vacances 8 j → vacation sûr',
        );
        assert.deepStrictEqual(
            cat(
                ev({
                    title: 'Assomption',
                    date: '2026-08-15',
                    allDay: true,
                    start: null,
                    durationMin: null,
                }),
            ),
            { category: 'holiday', sure: true },
            'Assomption → holiday sûr',
        );
        assert.deepStrictEqual(
            cat(EVENTS[0]),
            { category: 'call', sure: true },
            'Call Acme → call sûr',
        );
        // samedi 2026-07-04 → dimanche 2026-07-05, journée entière
        assert.deepStrictEqual(
            cat(
                ev({
                    title: 'Off',
                    date: '2026-07-04',
                    endDate: '2026-07-05',
                    allDay: true,
                    start: null,
                    durationMin: null,
                }),
            ),
            { category: 'weekend', sure: true },
            'sam-dim journée entière → weekend sûr',
        );
        assert.deepStrictEqual(
            cat(ev({ title: 'Apéro chez Max', start: '19:00' })),
            { category: 'afterwork', sure: true },
            'apéro → afterwork sûr',
        );
        assert.deepStrictEqual(
            cat(ev({ title: 'Truc', attendees: ['acme@corp.com'] })),
            { category: 'meeting-pro', sure: false },
            'participant à domaine pro → meeting-pro incertain',
        );
        assert.deepStrictEqual(
            cat(ev({ title: 'Truc', attendees: ['bob@gmail.com'] })),
            { category: 'autre', sure: false },
            'rien ne colle → autre incertain',
        );
        assert.deepStrictEqual(
            cat(ev({ title: 'Point', description: 'via Zoom' })),
            { category: 'call', sure: true },
            'la description compte (zoom → call)',
        );
        // un événement horaire étalé sur 3 jours n'est pas un bloc de vacances
        assert.deepStrictEqual(
            cat(
                ev({
                    title: 'Call',
                    date: '2026-06-25',
                    endDate: '2026-06-27',
                }),
            ),
            { category: 'call', sure: true },
            'multi-jour horaire → pas vacances (seul un bloc journée entière l’est)',
        );
        assert.deepStrictEqual(
            cat(ev({ title: 'Réunion salle B' })),
            { category: 'meeting-pro', sure: false },
            '« salle » n’est pas un mot-clé perso',
        );
        // les fériés datés sont des mots entiers : « 18 mai » n'est pas « 8 mai »
        assert.deepStrictEqual(
            cat(ev({ title: 'Dentiste 18 mai', start: '09:00' })),
            { category: 'perso', sure: true },
            '18 mai ne matche pas le férié du 8 mai',
        );
        assert.deepStrictEqual(
            cat(
                ev({
                    title: 'Pont du 8 mai',
                    date: '2026-05-08',
                    allDay: true,
                    start: null,
                    durationMin: null,
                }),
            ),
            { category: 'holiday', sure: true },
            '8 mai → holiday sûr',
        );
    }

    // ── checkText : mêmes règles que le garde du composeur ──────────────────────
    {
        assert.strictEqual(checkText(null, ['Call Acme']), null);
        assert.strictEqual(checkText('', ['Call Acme']), null);
        assert.strictEqual(
            checkText('Relire le doc.', ['Call Acme']),
            'Relire le doc.',
        );
        assert.strictEqual(
            checkText('Voir avec Bastien.', ['Call Acme']),
            null,
            'nom propre absent des faits → refusé',
        );
        assert.strictEqual(
            checkText('Salle 12.', ['Call Acme']),
            null,
            'nombre absent des faits → refusé',
        );
        assert.strictEqual(
            checkText('Chez Bastien vendredi.', ['Chez Bastien à Lyon']),
            'Chez Bastien vendredi.',
        );
        // le lexique lit des libellés : le premier mot d'un titre compte
        assert.strictEqual(
            checkText('Appeler Bastien.', ['Bastien dîner']),
            'Appeler Bastien.',
            'premier mot du titre dans le lexique',
        );
        assert.strictEqual(
            checkText('Préparer le point Acme.', ['Point Acme']),
            'Préparer le point Acme.',
        );
    }

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
        // un événement journée multi-jour expose sa plage + son nombre de jours
        assert.ok(
            user.includes('→ 2026-07-24') && /\(15 jours\)/.test(user),
            'user: plage multi-jour + nb jours (durée visible par le LLM)',
        );
        assert.ok(
            user.includes('desc: Chez Bastien à Lyon'),
            'user: description sérialisée pour le LLM',
        );
        assert.ok(
            /semaine/i.test(system) &&
                /professionnelle|professional/i.test(system),
            'system: règle réunions pro = semaine en cours',
        );
        assert.ok(/desc/i.test(system), 'system: consigne usage description');
        assert.ok(
            /omets/i.test(system) && /7 prochains jours/.test(system),
            'system: omettre = ne pas afficher, sauf proches / vacances / fériés',
        );
        assert.ok(
            /countdown/i.test(system),
            'system: consigne countdown (dans X jours)',
        );
        // annotation seulement : le schéma ne redemande ni titre, ni date, ni lieu
        assert.ok(
            system.includes('"id": string') &&
                system.includes('"importance": number'),
            'system: schéma par id',
        );
        assert.ok(
            !/"title"|"date"|"start"|"location"|"allDay"/.test(system),
            'system: le LLM ne renvoie pas les champs factuels',
        );
        assert.ok(
            !/rappel/i.test(system),
            'system: plus de « rappel vacances »',
        );
        // catégories déjà fixées par les règles : dites au LLM, par id
        assert.ok(
            /\[e1\][^\n]*call[^\n]*fix/i.test(user) &&
                /\[e2\][^\n]*vacation[^\n]*fix/i.test(user),
            'user: catégorie fixée annoncée sur la ligne de l’événement',
        );
        const unsure = buildSecretaryPrompt(
            [ev({ id: 'e3', title: 'Entretien Kinéis' })],
            NOW,
        ).user;
        assert.ok(
            /\[e3\][^\n]*choisir/i.test(unsure),
            'user: catégorie incertaine → à choisir',
        );
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
                        category: 'call',
                        importance: 80,
                        note: 'Relire le doc.',
                        detail: 'full',
                    },
                ],
            }) +
            '\n```\nVoilà.';
        const data = parseJudgment(llm, EVENTS, NOW);
        assert.ok(data, 'parse OK');
        assert.strictEqual(data!.briefing, 'Call à 10h.');
        const e1 = data!.items.find((it) => it.id === 'e1')!;
        assert.strictEqual(e1.category, 'call');
        assert.strictEqual(e1.importance, 80);
        assert.strictEqual(e1.note, 'Relire le doc.');
        assert.strictEqual(e1.detail, 'full');
        assert.strictEqual(
            e1.countdown,
            false,
            'call sans flag countdown → false',
        );
        assert.ok(
            typeof data!.judgedAt === 'string' && data!.judgedAt.length > 0,
            'judgedAt posé côté serveur',
        );
    }

    // ── parseJudgment : ancrage strict sur les événements source ────────────────
    {
        const llm = JSON.stringify({
            briefing: 'Call Acme à 10:00, puis vacances à Lyon.',
            items: [
                {
                    id: 'e9',
                    category: 'perso',
                    importance: 90,
                    note: 'Inventé.',
                    detail: 'full',
                },
                {
                    id: 'e1',
                    title: 'Rendez-vous kiné',
                    date: '2026-06-26',
                    start: '15:00',
                    location: 'Cabinet',
                    category: 'perso',
                    importance: 70,
                    note: 'Voir avec Bastien.',
                    detail: 'full',
                },
            ],
        });
        const data = parseJudgment(llm, EVENTS, NOW)!;
        assert.ok(data);
        assert.deepStrictEqual(
            data.items.map((it) => it.id),
            ['e1', 'e2'],
            'id inconnu jeté ; ordre = événements source',
        );
        const e1 = data.items[0];
        assert.strictEqual(e1.title, 'Call Acme', 'titre source conservé');
        assert.strictEqual(e1.date, '2026-06-25', 'date source conservée');
        assert.strictEqual(e1.start, '10:00', 'heure source conservée');
        assert.strictEqual(e1.location, 'Visio', 'lieu source conservé');
        assert.strictEqual(e1.durationMin, 60, 'durée source conservée');
        assert.strictEqual(
            e1.category,
            'call',
            'catégorie sûre imposée malgré le LLM',
        );
        assert.strictEqual(e1.importance, 70, 'importance du LLM gardée');
        assert.strictEqual(
            e1.note,
            null,
            'note citant un nom absent de l’événement → supprimée',
        );
        const e2 = data.items[1];
        assert.strictEqual(e2.category, 'vacation', 'absent → catégorie règle');
        assert.strictEqual(e2.importance, 50, 'absent → importance 50');
        assert.strictEqual(e2.note, null, 'absent → note null');
        assert.strictEqual(e2.detail, 'normal', 'absent → detail normal');
        assert.strictEqual(e2.countdown, true, 'absent + vacances → countdown');
        assert.strictEqual(
            e2.endDate,
            '2026-07-24',
            'endDate depuis la source',
        );
        assert.strictEqual(
            data.briefing,
            'Call Acme à 10:00, puis vacances à Lyon.',
            'briefing ancré sur les faits des événements → conservé',
        );
    }

    // ── parseJudgment : note ancrée conservée, briefing inventé supprimé ────────
    {
        const llm = JSON.stringify({
            briefing: 'Tu pars à Marseille bientôt.',
            items: [
                {
                    id: 'e2',
                    category: 'weekend',
                    importance: 90,
                    note: 'Chez Bastien à Lyon, prévoir le train.',
                    detail: 'full',
                },
            ],
        });
        const data = parseJudgment(llm, EVENTS, NOW)!;
        const e2 = data.items.find((it) => it.id === 'e2')!;
        assert.strictEqual(
            e2.note,
            'Chez Bastien à Lyon, prévoir le train.',
            'note citant la description → conservée',
        );
        assert.strictEqual(e2.category, 'vacation', 'weekend refusé (sûr)');
        assert.strictEqual(e2.detail, 'full');
        assert.strictEqual(
            data.briefing,
            '',
            'briefing citant un lieu inconnu → vidé',
        );
    }

    // ── parseJudgment : countdown explicite + repli vacances/férié ──────────────
    {
        const src: AgendaEvent[] = [
            ev({
                id: 'a',
                title: 'Anniv Bastien',
                allDay: true,
                start: null,
                durationMin: null,
            }),
            ev({
                id: 'b',
                title: 'Vacances',
                date: '2026-07-10',
                allDay: true,
                start: null,
                durationMin: null,
            }),
            ev({ id: 'c', title: 'Psy', date: '2026-07-02', start: '18:00' }),
        ];
        const llm = JSON.stringify({
            briefing: 'x',
            items: [
                {
                    id: 'a',
                    category: 'perso',
                    importance: 60,
                    detail: 'minimal',
                    countdown: true,
                },
                {
                    id: 'b',
                    category: 'vacation',
                    importance: 90,
                    detail: 'normal',
                    // pas de countdown → doit être true par repli (vacances)
                },
                {
                    id: 'c',
                    category: 'perso',
                    importance: 40,
                    detail: 'normal',
                },
            ],
        });
        const data = parseJudgment(llm, src, NOW)!;
        assert.strictEqual(data.items[0].category, 'perso', 'incertain → LLM');
        assert.strictEqual(data.items[0].countdown, true, 'anniv → countdown');
        assert.strictEqual(
            data.items[1].countdown,
            true,
            'vacances sans flag → countdown par repli',
        );
        assert.strictEqual(
            data.items[2].countdown,
            false,
            'psy (routine) → pas de countdown',
        );
    }

    // ── parseJudgment : normalisation (catégorie inconnue → autre, importance clampée) ─
    {
        const src = [
            ev({ id: 'e9', title: 'Truc', allDay: true, start: null }),
        ];
        const llm = JSON.stringify({
            briefing: 'x',
            items: [
                {
                    id: 'e9',
                    category: 'licorne',
                    importance: 999,
                    note: null,
                    detail: 'wat',
                },
            ],
        });
        const data = parseJudgment(llm, src, NOW);
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

    // ── parseJudgment : un absent de la réponse n'est gardé que s'il est proche
    //    (≤ 7 j) ou attendu (vacances / férié) — sinon le LLM a choisi de le taire ─
    {
        const src: AgendaEvent[] = [
            ev({ id: 'far', title: 'Réunion projet', date: '2026-07-15' }), // J+20
            ev({ id: 'near', title: 'Réunion projet', date: '2026-06-28' }), // J+3
            EVENTS[1], // vacances à J+15, absente aussi
        ];
        const data = parseJudgment(
            JSON.stringify({ briefing: '', items: [] }),
            src,
            NOW,
        )!;
        assert.deepStrictEqual(
            data.items.map((it) => it.id),
            ['near', 'e2'],
            'absent lointain jeté ; absent proche et vacances gardés',
        );
        // présent dans la réponse → toujours émis, même lointain
        const kept = parseJudgment(
            JSON.stringify({
                briefing: '',
                items: [{ id: 'far', importance: 30, detail: 'minimal' }],
            }),
            src,
            NOW,
        )!;
        assert.deepStrictEqual(
            kept.items.map((it) => it.id),
            ['far', 'near', 'e2'],
            'présent dans la réponse → émis',
        );
    }

    // ── parseJudgment : lexique de la note = tout le titre ; briefing = événements émis ─
    {
        const src: AgendaEvent[] = [
            ev({ id: 'd', title: 'Bastien dîner', date: '2026-06-26' }),
            ev({ id: 'far', title: 'Réunion Marseille', date: '2026-08-20' }), // absent, lointain
        ];
        const data = parseJudgment(
            JSON.stringify({
                briefing: 'Dîner avec Marseille en vue.',
                items: [
                    {
                        id: 'd',
                        importance: 60,
                        note: 'Appeler Bastien.',
                        detail: 'normal',
                    },
                ],
            }),
            src,
            NOW,
        )!;
        assert.deepStrictEqual(
            data.items.map((it) => it.id),
            ['d'],
        );
        assert.strictEqual(
            data.items[0].note,
            'Appeler Bastien.',
            'nom en tête de titre → note conservée',
        );
        assert.strictEqual(
            data.briefing,
            '',
            'briefing citant un événement non émis → vidé',
        );
    }

    // ── parseJudgment : JSON invalide / vide → null ─────────────────────────────
    {
        assert.strictEqual(parseJudgment('pas de json ici', EVENTS, NOW), null);
        assert.strictEqual(parseJudgment('', EVENTS, NOW), null);
        assert.strictEqual(
            parseJudgment('{ briefing: cassé', EVENTS, NOW),
            null,
        );
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
                                duration_min: 60,
                                location: 'Visio',
                                attendees: [
                                    { name: 'Acme', response: 'accepted' },
                                ],
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
                                end_date: '2026-07-24',
                                all_day: true,
                                location: null,
                                note: 'Séjour Lyon',
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
        assert.deepStrictEqual(evs[0].attendees, ['Acme']);
        assert.strictEqual(evs[0].endDate, null, 'pas de end_date → null');
        assert.strictEqual(evs[0].durationMin, 60, 'duration_min capturé');
        assert.strictEqual(evs[0].description, null, 'pas de note → null');
        assert.strictEqual(evs[1].allDay, true);
        assert.strictEqual(
            evs[1].endDate,
            '2026-07-24',
            'end_date multi-jour capturé',
        );
        assert.strictEqual(
            evs[1].description,
            'Séjour Lyon',
            'note (description) capturée',
        );
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
                            end_date: '2026-06-27',
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
                    category: 'call',
                    importance: 70,
                    note: null,
                    detail: 'full',
                },
            ],
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
            assert.strictEqual(
                a!.items[0].endDate,
                '2026-06-27',
                'endDate réinjecté depuis l’event source (par id)',
            );
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
