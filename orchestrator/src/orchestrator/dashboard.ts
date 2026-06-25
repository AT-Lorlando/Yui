import parser from 'cron-parser';
import type { Automation } from './automations';

export interface DashboardWeather {
    current: { city: string; condition: string; temp: number; feels: number };
    forecast: Array<{
        date: string;
        condition: string;
        min: number;
        max: number;
        rainProb: number | null;
    }>;
}

export interface DashboardEvent {
    title: string;
    date: string;
    allDay: boolean;
    start: string | null; // "HH:MM" ou null (journée entière)
    location: string | null;
}

export interface DashboardData {
    weather: DashboardWeather | null;
    agenda:
        | { judged: import('./agendaSecretary').AgendaData }
        | { fallback: { next: DashboardEvent | null; today: DashboardEvent[] } }
        | null;
    mail: { count: number; text: string } | null;
    automation: { name: string; at: string } | null; // at = ISO
    presence: {
        state: string;
        lightsOn: number | null;
        doorLocked: boolean | null;
    } | null;
    proactive: { message: string; at: string } | null;
    generatedAt: string;
}

export interface DashboardDeps {
    callTool: (
        name: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>;
    presenceState: () => string;
    automations: () => Automation[];
    proactiveLastMessage: () => { message: string; at: number } | null;
    mailQuery?: string;
    judgedAgenda: () => Promise<import('./agendaSecretary').AgendaData | null>;
}

const BLOCK_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let tid: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((_, rej) => {
        tid = setTimeout(() => rej(new Error('dashboard block timeout')), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(tid));
}

/** Exécute fn ; renvoie null sur toute erreur ou timeout (jamais de throw). */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
        return await withTimeout(fn(), BLOCK_TIMEOUT_MS);
    } catch {
        return null;
    }
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function normalizeEvent(ev: Record<string, unknown>): DashboardEvent {
    return {
        title: String(ev.title ?? '(Sans titre)'),
        date: String(ev.date ?? ''),
        allDay: ev.all_day === true,
        start: typeof ev.start === 'string' ? ev.start : null,
        location: typeof ev.location === 'string' ? ev.location : null,
    };
}

/** Aplati un résultat get_today/get_week ({days:[{date,events}]}) en events[]. */
function flattenAgenda(result: unknown): DashboardEvent[] {
    if (!isObj(result) || !Array.isArray(result.days)) return [];
    const out: DashboardEvent[] = [];
    for (const day of result.days as Array<Record<string, unknown>>) {
        const events = Array.isArray(day.events) ? day.events : [];
        for (const ev of events as Array<Record<string, unknown>>) {
            if (ev.cancelled === true) continue;
            out.push(normalizeEvent(ev));
        }
    }
    return out;
}

/** Clé triable approximative : "YYYY-MM-DDTHH:MM" (00:00 si journée entière). */
function eventKey(ev: DashboardEvent): string {
    return `${ev.date}T${ev.start ?? '00:00'}`;
}

function buildWeather(
    current: unknown,
    forecast: unknown,
): DashboardWeather | null {
    if (!isObj(current)) return null;
    const num = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    };
    const fc =
        isObj(forecast) && Array.isArray(forecast.forecast)
            ? (forecast.forecast as Array<Record<string, unknown>>)
            : [];
    return {
        current: {
            city: String(current.city ?? ''),
            condition: String(current.condition ?? ''),
            temp: num(current.temperature_c),
            feels: num(
                current.feels_like_c !== undefined
                    ? current.feels_like_c
                    : current.temperature_c,
            ),
        },
        forecast: fc.slice(0, 5).map((f) => ({
            date: String(f.date ?? ''),
            condition: String(f.condition ?? ''),
            min: num(f.temp_min_c),
            max: num(f.temp_max_c),
            rainProb:
                f.precipitation_prob === undefined ||
                f.precipitation_prob === null
                    ? null
                    : Number.isFinite(Number(f.precipitation_prob))
                    ? Number(f.precipitation_prob)
                    : null,
        })),
    };
}

function parseMail(result: unknown): { count: number; text: string } | null {
    if (typeof result !== 'string') return null;
    if (result.startsWith('Aucun email')) return null;
    const m = result.match(/^(\d+)\s+résultat/);
    const count = m ? Number(m[1]) : 0;
    if (count === 0) return null;
    return { count, text: result };
}

function countLightsOn(result: unknown): number | null {
    if (!Array.isArray(result)) return null;
    let n = 0;
    for (const l of result as Array<Record<string, unknown>>) {
        const on =
            l.on === true ||
            (isObj(l.state) &&
                (l.state as Record<string, unknown>).on === true);
        if (on) n++;
    }
    return n;
}

function doorsLocked(result: unknown): boolean | null {
    if (!Array.isArray(result) || result.length === 0) return null;
    return (result as Array<Record<string, unknown>>).every((d) => {
        const sn =
            (d as Record<string, unknown>).stateName ??
            (isObj(d.state)
                ? (d.state as Record<string, unknown>).stateName
                : undefined);
        return sn === 'locked';
    });
}

/** Prochaine occurrence d'une automation activée (cron ou delay), ou null. */
function nextAutomation(
    automations: Automation[],
): { name: string; at: string } | null {
    const now = Date.now();
    let best: { name: string; at: number } | null = null;
    for (const a of automations) {
        if (!a.enabled) continue;
        let at: number | null = null;
        if (a.trigger.type === 'delay') {
            at = a.trigger.fireAt > now ? a.trigger.fireAt : null;
        } else if (a.trigger.type === 'cron') {
            try {
                at = parser.parseExpression(a.trigger.expr).next().getTime();
            } catch {
                at = null;
            }
        }
        if (at !== null && (!best || at < best.at)) best = { name: a.name, at };
    }
    return best
        ? { name: best.name, at: new Date(best.at).toISOString() }
        : null;
}

export async function buildDashboard(
    deps: DashboardDeps,
): Promise<DashboardData> {
    const [weatherRaw, forecastRaw, today, week, mailRaw, lightsRaw, doorsRaw] =
        await Promise.all([
            safe(() => deps.callTool('get_current_weather')),
            safe(() => deps.callTool('get_forecast', { days: 5 })),
            safe(() => deps.callTool('get_today')),
            safe(() => deps.callTool('get_week')),
            deps.mailQuery
                ? safe(() =>
                      deps.callTool('search_emails', { query: deps.mailQuery }),
                  )
                : Promise.resolve(null),
            safe(() => deps.callTool('list_lights')),
            safe(() => deps.callTool('list_doors')),
        ]);

    const weather =
        weatherRaw === null ? null : buildWeather(weatherRaw, forecastRaw);

    const judged = await safe(() => deps.judgedAgenda());
    let agenda: DashboardData['agenda'] = null;
    if (judged) {
        agenda = { judged };
    } else if (today !== null || week !== null) {
        const todayEvents = flattenAgenda(today);
        const weekEvents = flattenAgenda(week);
        const nowKey = new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
        const upcoming = weekEvents
            .filter((e) => eventKey(e) >= nowKey)
            .sort((a, b) => eventKey(a).localeCompare(eventKey(b)));
        agenda = {
            fallback: { next: upcoming[0] ?? null, today: todayEvents },
        };
    }

    let presenceStateValue = 'unknown';
    try {
        presenceStateValue = deps.presenceState();
    } catch {
        /* keep 'unknown' */
    }
    const presence = {
        state: presenceStateValue,
        lightsOn: countLightsOn(lightsRaw),
        doorLocked: doorsLocked(doorsRaw),
    };

    const last = deps.proactiveLastMessage();

    return {
        weather,
        agenda,
        mail: parseMail(mailRaw),
        automation: nextAutomation(deps.automations()),
        presence,
        proactive: last
            ? { message: last.message, at: new Date(last.at).toISOString() }
            : null,
        generatedAt: new Date().toISOString(),
    };
}

/** Provider avec cache mémoire (absorbe le polling, ménage les MCP). */
export function createDashboardProvider(
    deps: DashboardDeps,
    ttlMs = 30_000,
): () => Promise<DashboardData> {
    let cache: { at: number; data: DashboardData } | null = null;
    let inflight: Promise<DashboardData> | null = null;
    return async () => {
        const now = Date.now();
        if (cache && now - cache.at < ttlMs) return cache.data;
        if (inflight) return inflight;
        inflight = buildDashboard(deps)
            .then((data) => {
                cache = { at: Date.now(), data };
                return data;
            })
            .finally(() => {
                inflight = null;
            });
        return inflight;
    };
}
