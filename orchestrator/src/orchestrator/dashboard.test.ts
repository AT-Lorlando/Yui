import assert from 'assert';
import { buildDashboard, type DashboardDeps } from './dashboard';

// Canned MCP outputs (déjà parsés, comme le ferait callTool).
const CURRENT = {
    city: 'Lyon',
    condition: 'Ciel dégagé',
    temperature_c: 18,
    feels_like_c: 17,
};
const FORECAST = {
    city: 'Lyon',
    days: 5,
    forecast: [
        {
            date: '2026-06-24',
            condition: 'Ciel dégagé',
            temp_min_c: 12,
            temp_max_c: 24,
            precipitation_prob: 5,
        },
        {
            date: '2026-06-25',
            condition: 'Pluie',
            temp_min_c: 14,
            temp_max_c: 21,
            precipitation_prob: 80,
        },
    ],
};
const TODAY = {
    start: '2026-06-24',
    end: '2026-06-24',
    days: [
        {
            date: '2026-06-24',
            events: [
                {
                    title: 'Standup',
                    date: '2026-06-24',
                    all_day: false,
                    start: '09:30',
                    end: '10:00',
                    location: 'Visio',
                },
            ],
        },
    ],
};
const WEEK = {
    start: '2026-06-24',
    end: '2026-06-30',
    days: [
        {
            date: '2026-06-26',
            events: [
                {
                    title: 'Dentiste',
                    date: '2026-06-26',
                    all_day: false,
                    start: '15:00',
                    end: '15:45',
                    location: 'Cabinet',
                },
            ],
        },
    ],
};
const MAIL_HITS =
    '2 résultat(s) pour "is:important is:unread" :\n\n[1]\nDe: Banque\nObjet: Relevé';
const MAIL_EMPTY = 'Aucun email pour la recherche : "is:important is:unread"';
const LIGHTS = [
    { id: '1', name: 'Salon', state: { on: true } },
    { id: '2', name: 'Cuisine', state: { on: false } },
    { id: '3', name: 'Bureau', state: { on: true } },
];
const DOORS = [{ id: 'd1', name: 'Entrée', state: { stateName: 'locked' } }];

function makeDeps(over: Partial<DashboardDeps> = {}): DashboardDeps {
    const callTool = async (name: string): Promise<unknown> => {
        switch (name) {
            case 'get_current_weather':
                return CURRENT;
            case 'get_forecast':
                return FORECAST;
            case 'get_today':
                return TODAY;
            case 'get_week':
                return WEEK;
            case 'search_emails':
                return MAIL_HITS;
            case 'list_lights':
                return LIGHTS;
            case 'list_doors':
                return DOORS;
            default:
                throw new Error(`unexpected tool ${name}`);
        }
    };
    return {
        callTool,
        presenceState: () => 'home',
        automations: () => [
            {
                id: 'a1',
                name: 'Arrosage',
                enabled: true,
                trigger: { type: 'cron', expr: '0 7 * * *' },
            } as any,
        ],
        proactiveLastMessage: () => ({
            message: 'Pense à fermer les volets.',
            at: 1750000000000,
        }),
        mailQuery: 'is:important is:unread',
        judgedAgenda: async () => null, // défaut : repli chronologique
        ...over,
    };
}

async function run(): Promise<void> {
    // ── nominal ───────────────────────────────────────────────────────────────
    {
        const d = await buildDashboard(makeDeps());
        assert.ok(d.weather, 'weather présent');
        assert.strictEqual(d.weather!.current.temp, 18);
        assert.strictEqual(d.weather!.forecast.length, 2);
        assert.strictEqual(d.weather!.forecast[1].rainProb, 80);

        assert.ok(
            d.agenda && 'fallback' in d.agenda,
            'agenda en repli quand judgedAgenda=null',
        );
        assert.strictEqual(d.agenda.fallback.today.length, 1);
        assert.strictEqual(d.agenda.fallback.today[0].title, 'Standup');
        assert.strictEqual(d.agenda.fallback.next!.title, 'Dentiste');

        assert.ok(d.mail, 'mail présent');
        assert.strictEqual(d.mail!.count, 2);

        assert.ok(d.presence, 'presence présent');
        assert.strictEqual(d.presence!.state, 'home');
        assert.strictEqual(d.presence!.lightsOn, 2);
        assert.strictEqual(d.presence!.doorLocked, true);

        assert.ok(d.automation, 'automation présent');
        assert.strictEqual(d.automation!.name, 'Arrosage');
        assert.ok(
            typeof d.automation!.at === 'string' && d.automation!.at.length > 0,
        );

        assert.ok(d.proactive, 'proactive présent');
        assert.strictEqual(d.proactive!.message, 'Pense à fermer les volets.');

        assert.ok(typeof d.generatedAt === 'string');
    }

    // ── mail vide → null (module masqué côté front) ─────────────────────────────
    {
        const deps = makeDeps();
        const base = deps.callTool;
        deps.callTool = async (n: string, a?: any) =>
            n === 'search_emails' ? MAIL_EMPTY : base(n, a);
        const d = await buildDashboard(deps);
        assert.strictEqual(d.mail, null, 'mail vide → null');
    }

    // ── dégradation : un tool qui throw ⇒ son bloc null, le reste OK ────────────
    {
        const deps = makeDeps();
        const base = deps.callTool;
        deps.callTool = async (n: string, a?: any) => {
            if (n === 'get_current_weather' || n === 'get_forecast')
                throw new Error('weather down');
            return base(n, a);
        };
        const d = await buildDashboard(deps);
        assert.strictEqual(d.weather, null, 'weather KO → null');
        assert.ok(d.agenda, 'agenda toujours présent malgré météo KO');
        assert.ok(d.mail, 'mail toujours présent');
    }

    // ── agenda jugé (judgedAgenda renvoie des données) ─────────────────────────
    {
        const judged = {
            briefing: 'Call à 10h.',
            items: [
                {
                    id: 'e1',
                    title: 'Call Acme',
                    date: '2026-06-24',
                    start: '10:00',
                    allDay: false,
                    location: 'Visio',
                    category: 'call',
                    categoryLabel: null,
                    importance: 80,
                    note: null,
                    detail: 'full',
                },
            ],
            judgedAt: '2026-06-24T08:00:00.000Z',
        };
        const d = await buildDashboard(
            makeDeps({ judgedAgenda: async () => judged as any }),
        );
        assert.ok(d.agenda && 'judged' in d.agenda, 'agenda en mode jugé');
        assert.strictEqual(d.agenda.judged.items[0].category, 'call');
        assert.strictEqual(d.agenda.judged.briefing, 'Call à 10h.');
    }

    console.log('dashboard.test.ts OK');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
