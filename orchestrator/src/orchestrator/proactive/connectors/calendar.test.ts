import assert from 'assert';
import {
    calendarConnector,
    diffAgenda,
    earlyTomorrow,
    todayFacts,
} from './calendar';
import type { AgendaSnapshot } from './calendar';
import { ConnectorState } from '../connectorState';
import type { ConnectorContext } from '../connector';
import type { AgendaEvent } from '../../agendaSecretary';
import type { PresenceState } from '../../presence';

// Vendredi 25 septembre 2026, 10 h (heure locale).
const NOW = new Date('2026-09-25T10:00:00').getTime();
const H = 3600_000;
const DAY = 24 * H;

function ev(partial: Partial<AgendaEvent> & { id: string }): AgendaEvent {
    return {
        title: 'Sans titre',
        date: '2026-10-05',
        endDate: null,
        start: '14:00',
        allDay: false,
        location: null,
        description: null,
        durationMin: null,
        attendees: [],
        ...partial,
    };
}

function snapshotOf(events: AgendaEvent[]): AgendaSnapshot {
    return diffAgenda({}, events, NOW).snapshot;
}

function testDiffAgenda(): void {
    const far = ev({ id: 'e1', title: 'Dentiste', date: '2026-10-05' });

    // Premier poll : rien n'est émis, l'instantané est mémorisé.
    const first = diffAgenda({}, [far], NOW);
    assert.deepStrictEqual(first.events, [], 'premier poll silencieux');
    assert.deepStrictEqual(first.snapshot.e1, {
        title: 'Dentiste',
        date: '2026-10-05',
        start: '14:00',
        endDate: null,
        location: null,
        seenTitleCount: 1,
    });

    // Nouvel événement à J+10 → « new », forme complète.
    const known = snapshotOf([ev({ id: 'e0', title: 'Kiné' })]);
    const added = diffAgenda(
        known,
        [ev({ id: 'e0', title: 'Kiné' }), far],
        NOW,
    );
    assert.strictEqual(added.events.length, 1);
    const e = added.events[0]!;
    assert.strictEqual(e.source, 'calendar');
    assert.strictEqual(e.kind, 'info');
    assert.strictEqual(e.importance, 'utile');
    assert.match(e.key, /^agenda-e1-new-[0-9a-f]{8}$/);
    assert.strictEqual(
        e.subject,
        'Tu as ajouté “Dentiste” le lundi 5 octobre à 14:00',
    );
    assert.deepStrictEqual(e.facts, ['nature:agenda-far']);
    assert.strictEqual(e.at, NOW);
    const startMs = new Date('2026-10-05T14:00:00').getTime();
    assert.strictEqual(e.ttlMs, startMs - NOW, "ttl = jusqu'à l'événement");
    assert.strictEqual(added.snapshot.e1?.title, 'Dentiste');

    // Journée entière : pas d'heure dans le sujet.
    const allDay = diffAgenda(
        known,
        [
            ev({ id: 'e0', title: 'Kiné' }),
            ev({ id: 'e2', title: 'Salon', start: null, allDay: true }),
        ],
        NOW,
    );
    assert.strictEqual(
        allDay.events[0]!.subject,
        'Tu as ajouté “Salon” le lundi 5 octobre',
    );

    // Récurrent : même titre déjà vu 2 fois dans l'instantané précédent → rien.
    const recurring = snapshotOf([
        ev({ id: 'r1', title: 'Point équipe', date: '2026-09-28' }),
        ev({ id: 'r2', title: 'Point équipe', date: '2026-10-05' }),
    ]);
    assert.strictEqual(recurring.r1?.seenTitleCount, 2);
    const rec = diffAgenda(
        recurring,
        [
            ev({ id: 'r1', title: 'Point équipe', date: '2026-09-28' }),
            ev({ id: 'r2', title: 'Point équipe', date: '2026-10-05' }),
            ev({ id: 'r3', title: 'Point équipe', date: '2026-10-12' }),
        ],
        NOW,
    );
    assert.deepStrictEqual(rec.events, [], 'réunion récurrente exclue');
    assert.strictEqual(rec.snapshot.r3?.seenTitleCount, 3);

    // Déplacé : nouvelle empreinte, sujet avec la nouvelle date et le lieu.
    const before = snapshotOf([far]);
    const moved = diffAgenda(
        before,
        [
            ev({
                id: 'e1',
                title: 'Dentiste',
                date: '2026-10-06',
                start: '09:30',
                location: 'Toulouse',
            }),
        ],
        NOW,
    );
    assert.strictEqual(moved.events.length, 1);
    assert.match(moved.events[0]!.key, /^agenda-e1-moved-[0-9a-f]{8}$/);
    assert.notStrictEqual(
        moved.events[0]!.key.slice(-8),
        e.key.slice(-8),
        'empreinte différente après déplacement',
    );
    assert.strictEqual(
        moved.events[0]!.subject,
        '“Dentiste” passe au mardi 6 octobre à 09:30, Toulouse',
    );
    assert.strictEqual(moved.snapshot.e1?.date, '2026-10-06');
    // Inchangé → rien.
    assert.deepStrictEqual(diffAgenda(before, [far], NOW).events, []);

    // Disparu et futur → « cancelled » ; disparu et passé → rien.
    const gone = diffAgenda(
        snapshotOf([far, ev({ id: 'p1', title: 'Hier', date: '2026-09-24' })]),
        [],
        NOW,
    );
    assert.deepStrictEqual(gone.events, [], 'liste vide = lecture douteuse');
    const cancelled = diffAgenda(
        snapshotOf([
            far,
            ev({ id: 'p1', title: 'Hier', date: '2026-09-24' }),
            ev({ id: 'k1', title: 'Kiné', date: '2026-10-20' }),
        ]),
        [ev({ id: 'k1', title: 'Kiné', date: '2026-10-20' })],
        NOW,
    );
    assert.strictEqual(cancelled.events.length, 1);
    assert.match(cancelled.events[0]!.key, /^agenda-e1-cancelled-[0-9a-f]{8}$/);
    assert.strictEqual(
        cancelled.events[0]!.subject,
        "“Dentiste” du lundi 5 octobre a disparu de l'agenda",
    );
    assert.strictEqual(cancelled.events[0]!.ttlMs, startMs - NOW);
    assert.strictEqual(cancelled.snapshot.e1, undefined);
    assert.strictEqual(cancelled.snapshot.p1, undefined);

    // À moins de 24 h : ni nouveau, ni déplacé, ni annulé.
    const soon = ev({
        id: 's1',
        title: 'Café',
        date: '2026-09-25',
        start: '18:00',
    });
    const soonAdded = diffAgenda(
        known,
        [ev({ id: 'e0', title: 'Kiné' }), soon],
        NOW,
    );
    assert.deepStrictEqual(soonAdded.events, [], 'événement du jour tu');
    assert.ok(soonAdded.snapshot.s1, 'mais mémorisé');
    const tomorrowMorning = ev({
        id: 's2',
        title: 'Café',
        date: '2026-09-26',
        start: '09:00',
    });
    assert.deepStrictEqual(
        diffAgenda(
            known,
            [ev({ id: 'e0', title: 'Kiné' }), tomorrowMorning],
            NOW,
        ).events,
        [],
        'à 23 h : tu',
    );
    const soonCancelled = diffAgenda(
        snapshotOf([soon, ev({ id: 'k1', title: 'Kiné', date: '2026-10-20' })]),
        [ev({ id: 'k1', title: 'Kiné', date: '2026-10-20' })],
        NOW,
    );
    assert.deepStrictEqual(soonCancelled.events, []);

    // Bord lointain de la fenêtre glissante : un id inconnu à J+59 vient
    // d'entrer dans la lecture, ce n'est pas un ajout — mémorisé sans bruit.
    const kine = ev({ id: 'e0', title: 'Kiné' });
    const edge = ev({ id: 'far', title: 'Mariage', date: '2026-11-23' });
    const atEdge = diffAgenda(known, [kine, edge], NOW);
    assert.deepStrictEqual(atEdge.events, [], 'bord de fenêtre : silence');
    assert.ok(atEdge.snapshot.far, 'mais mémorisé');
    assert.strictEqual(atEdge.atCap, false);
    const mid = ev({ id: 'mid', title: 'Mariage', date: '2026-10-25' });
    assert.match(
        diffAgenda(known, [kine, mid], NOW).events[0]!.key,
        /^agenda-mid-new-/,
        'J+30 : ajout réel',
    );

    // Lecture précédente au plafond : sa coupure est arbitraire.
    const bulk = Array.from({ length: 100 }, (_, i) =>
        ev({
            id: `b${i}`,
            title: `Réunion ${i}`,
            date: `2026-10-${String(10 + (i % 15)).padStart(2, '0')}`,
        }),
    );
    const capped = diffAgenda({}, bulk, NOW);
    assert.strictEqual(capped.atCap, true);
    // Un id disparu n'est pas une annulation (il peut être derrière le plafond).
    const missing = diffAgenda(capped.snapshot, bulk.slice(1), NOW, true);
    assert.deepStrictEqual(missing.events, [], "au plafond : pas d'annulé");
    assert.strictEqual(missing.atCap, false);
    // Un id inconnu n'est « nouveau » qu'avant le dernier jour connu (24/10).
    const afterLast = ev({ id: 'n1', title: 'Concert', date: '2026-10-24' });
    const beforeLast = ev({ id: 'n2', title: 'Concert', date: '2026-10-15' });
    const unknowns = diffAgenda(
        capped.snapshot,
        [...bulk, afterLast, beforeLast],
        NOW,
        true,
    );
    assert.deepStrictEqual(
        unknowns.events.map((e) => e.key.replace(/-[0-9a-f]{8}$/, '')),
        ['agenda-n2-new'],
    );
    // Sans le plafond, la même disparition est bien une annulation.
    assert.strictEqual(
        diffAgenda(capped.snapshot, bulk.slice(1), NOW, false).events.length,
        1,
    );
}

function testEarlyTomorrow(): void {
    const evening = new Date('2026-09-25T21:00:00').getTime();
    const tomorrow = (start: string, id = 't1'): AgendaEvent =>
        ev({ id, title: 'Réunion', date: '2026-09-26', start });
    const history = ['09:30', '09:00', '10:00', '09:30', '08:45'];

    assert.strictEqual(
        earlyTomorrow([tomorrow('08:30')], evening, history)?.id,
        't1',
        'avant la médiane (09:30)',
    );
    assert.strictEqual(
        earlyTomorrow([tomorrow('09:15')], evening, history)?.id,
        't1',
        '09:15 < médiane 09:30',
    );
    assert.strictEqual(
        earlyTomorrow([tomorrow('09:45')], evening, history),
        null,
    );
    // Sans historique : seuil 9 h.
    assert.strictEqual(
        earlyTomorrow([tomorrow('08:30')], evening, [])?.id,
        't1',
    );
    assert.strictEqual(earlyTomorrow([tomorrow('09:15')], evening, []), null);
    // Médiane tôt (08:00) : 08:30 reste « tôt » car avant 9 h.
    assert.strictEqual(
        earlyTomorrow([tomorrow('08:30')], evening, ['08:00', '07:30', '08:00'])
            ?.id,
        't1',
    );
    // Le premier événement horaire de demain compte ; journée entière ignorée.
    assert.strictEqual(
        earlyTomorrow(
            [
                ev({
                    id: 'a',
                    title: 'Férié',
                    date: '2026-09-26',
                    start: null,
                    allDay: true,
                }),
                tomorrow('11:00', 'late'),
                tomorrow('08:00', 'early'),
                ev({
                    id: 'o',
                    title: 'Autre jour',
                    date: '2026-09-27',
                    start: '07:00',
                }),
            ],
            evening,
            [],
        )?.id,
        'early',
    );
    assert.strictEqual(earlyTomorrow([tomorrow('11:00')], evening, []), null);
    assert.strictEqual(earlyTomorrow([], evening, []), null);
    // Après minuit (01:00), « demain » est le matin qui vient : le jour courant.
    const night = new Date('2026-09-26T01:00:00').getTime();
    assert.strictEqual(earlyTomorrow([tomorrow('08:30')], night, [])?.id, 't1');
}

function testTodayFacts(): void {
    const facts = todayFacts(
        [
            ev({
                id: 'a',
                title: 'Kinéis',
                date: '2026-09-25',
                start: '10:20',
                location: 'Toulouse',
            }),
            ev({ id: 'b', title: 'Passé', date: '2026-09-25', start: '07:00' }),
            ev({ id: 'c', title: 'Loin', date: '2026-10-05' }),
        ],
        NOW,
    );
    assert.deepStrictEqual(facts, [
        { label: 'Agenda', value: 'Kinéis à 10:20 (Toulouse)' },
    ]);
}

// ── Connecteur ────────────────────────────────────────────────────────────────

interface FakeTools {
    schedule: Array<Record<string, unknown>>;
    today?: Array<Record<string, unknown>>;
    calls: string[];
}

function ctx(
    tools: FakeTools,
    state: ConnectorState,
    now: number,
): ConnectorContext {
    return {
        // Une fermeture neuve par contexte : le cache d'agenda est par
        // fonction callTool, chaque « poll » simulé lit donc ses données.
        callTool: async (name) => {
            tools.calls.push(name);
            if (name === 'get_schedule') {
                const days = new Map<string, unknown[]>();
                for (const e of tools.schedule) {
                    const d = String(e.date);
                    if (!days.has(d)) days.set(d, []);
                    days.get(d)!.push(e);
                }
                return {
                    days: [...days].map(([date, events]) => ({ date, events })),
                };
            }
            if (name === 'get_today') return { events: tools.today ?? [] };
            return null;
        },
        settings: { remindMinutesBefore: 30 },
        state,
        presence: () => 'home' as PresenceState,
        now: () => now,
        log: { info: () => {}, warn: () => {} },
    };
}

async function testConnector(): Promise<void> {
    const state = new ConnectorState();
    const dentist = {
        id: 'e1',
        title: 'Dentiste',
        date: '2026-10-05',
        start: '14:00',
    };

    // Premier poll : instantané mémorisé, rien d'émis.
    const t1: FakeTools = { schedule: [dentist], calls: [] };
    assert.deepStrictEqual(
        await calendarConnector.events!(ctx(t1, state, NOW)),
        [],
    );
    assert.ok(state.get<AgendaSnapshot>('agendaSnapshot', {}).e1);

    // Deuxième poll : un ajout à J+10 + un rappel du jour (chemin existant).
    const t2: FakeTools = {
        schedule: [
            dentist,
            { id: 'e2', title: 'Concert', date: '2026-10-10', start: '20:30' },
        ],
        today: [{ title: 'Kinéis', date: '2026-09-25', start: '10:20' }],
        calls: [],
    };
    const c2 = ctx(t2, state, NOW);
    const events = await calendarConnector.events!(c2);
    assert.deepStrictEqual(
        events.map((e) => e.key.replace(/-[0-9a-f]{8}$/, '')),
        ['event-2026-09-25-10:20', 'agenda-e2-new'],
    );
    assert.strictEqual(events[1]!.facts[0], 'nature:agenda-far');

    // Le snapshot du même tick réutilise la lecture du poll : un seul fetch.
    const facts = await calendarConnector.snapshot!(c2);
    assert.strictEqual(
        t2.calls.filter((n) => n === 'get_schedule').length,
        1,
        'un seul get_schedule par tick',
    );
    assert.ok(!facts.some((f) => f.label === 'Demain tôt'), 'pas en journée');

    // Le soir : « Demain tôt » si le premier événement de demain est tôt.
    const evening = new Date('2026-09-25T21:00:00').getTime();
    const t3: FakeTools = {
        schedule: [
            dentist,
            { id: 'm', title: 'Réunion', date: '2026-09-26', start: '08:30' },
        ],
        calls: [],
    };
    const late = await calendarConnector.snapshot!(ctx(t3, state, evening));
    assert.ok(
        late.some(
            (f) =>
                f.label === 'Demain tôt' && f.value === '« Réunion » à 08:30',
        ),
        `Demain tôt attendu : ${JSON.stringify(late)}`,
    );

    // Historique des débuts : le premier début du jour, une fois par jour ouvré.
    const t4: FakeTools = {
        schedule: [
            { id: 'a', title: 'Point', date: '2026-09-25', start: '11:00' },
            { id: 'b', title: 'Café', date: '2026-09-25', start: '09:15' },
            dentist,
        ],
        calls: [],
    };
    const hist = new ConnectorState();
    await calendarConnector.snapshot!(ctx(t4, hist, NOW));
    assert.deepStrictEqual(hist.get('startHistory', []), ['09:15']);
    await calendarConnector.snapshot!(ctx(t4, hist, NOW + H));
    assert.deepStrictEqual(
        hist.get('startHistory', []),
        ['09:15'],
        'une fois par jour',
    );
    // Samedi : pas un jour ouvré.
    const saturday = new Date('2026-09-26T10:00:00').getTime();
    await calendarConnector.snapshot!(
        ctx(
            {
                schedule: [
                    {
                        id: 's',
                        title: 'Marché',
                        date: '2026-09-26',
                        start: '08:00',
                    },
                ],
                calls: [],
            },
            hist,
            saturday,
        ),
    );
    assert.deepStrictEqual(
        hist.get('startHistory', []),
        ['09:15'],
        'samedi ignoré',
    );
    // Lundi : ajouté ; borné à 30 entrées.
    hist.set(
        'startHistory',
        Array.from({ length: 30 }, () => '09:00'),
    );
    const monday = new Date('2026-09-28T10:00:00').getTime();
    await calendarConnector.snapshot!(
        ctx(
            {
                schedule: [
                    {
                        id: 'l',
                        title: 'Réunion',
                        date: '2026-09-28',
                        start: '08:45',
                    },
                ],
                calls: [],
            },
            hist,
            monday,
        ),
    );
    const h = hist.get<string[]>('startHistory', []);
    assert.strictEqual(h.length, 30);
    assert.strictEqual(h[h.length - 1], '08:45');

    // Lecture en échec : les rappels sortent quand même, l'instantané est gardé.
    const failing: ConnectorContext = {
        ...ctx(t2, state, NOW + DAY),
        callTool: async (name) => {
            if (name === 'get_schedule') throw new Error('calendar down');
            return {
                events: [
                    { title: 'Kinéis', date: '2026-09-26', start: '10:20' },
                ],
            };
        },
    };
    const onFailure = await calendarConnector.events!(failing);
    assert.deepStrictEqual(
        onFailure.map((e) => e.key),
        ['event-2026-09-26-10:20'],
    );
    assert.ok(
        state.get<AgendaSnapshot>('agendaSnapshot', {}).e2,
        'instantané conservé',
    );
}

async function run(): Promise<void> {
    testDiffAgenda();
    testEarlyTomorrow();
    testTodayFacts();
    await testConnector();
    console.log('All calendar connector tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
