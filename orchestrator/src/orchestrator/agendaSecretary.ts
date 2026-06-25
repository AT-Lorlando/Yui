import { createHash } from 'crypto';

export interface AgendaEvent {
    id: string;
    title: string;
    date: string; // YYYY-MM-DD
    start: string | null; // "HH:MM" ou null (journée entière)
    allDay: boolean;
    location: string | null;
    attendees: string[];
}

export type AgendaCategory =
    | 'meeting-pro'
    | 'call'
    | 'afterwork'
    | 'weekend'
    | 'vacation'
    | 'perso'
    | 'autre';

const CATEGORIES: AgendaCategory[] = [
    'meeting-pro',
    'call',
    'afterwork',
    'weekend',
    'vacation',
    'perso',
    'autre',
];
const DETAILS = ['full', 'normal', 'minimal'] as const;
export type AgendaDetail = (typeof DETAILS)[number];

export interface AgendaItem {
    id: string;
    title: string;
    date: string;
    start: string | null;
    allDay: boolean;
    location: string | null;
    category: AgendaCategory;
    categoryLabel: string | null;
    importance: number; // 0-100
    note: string | null;
    detail: AgendaDetail;
}

export interface AgendaData {
    briefing: string;
    items: AgendaItem[];
    judgedAt: string; // ISO
}

const TAXONOMY_LINE = CATEGORIES.join(' | ');

export function buildSecretaryPrompt(
    events: AgendaEvent[],
    now: Date,
): { system: string; user: string } {
    const system =
        'Tu es la secrétaire personnelle de Jérémy. On te donne ses événements ' +
        "d'agenda des deux prochains mois. Sélectionne ce qui mérite d'être affiché " +
        "aujourd'hui (en détail) et les temps forts à venir (vacances, gros meetings) ; " +
        'ignore le bruit. Pour chaque événement retenu, choisis :\n' +
        `- category parmi : ${TAXONOMY_LINE} (si rien ne colle : "autre" + categoryLabel court).\n` +
        '- importance : entier 0-100 (un call client > un afterwork > un week-end off).\n' +
        '- note : courte phrase utile de secrétaire (ou null).\n' +
        '- detail : "full" (heure+lieu+participants+note), "normal" (heure+lieu), "minimal" (titre+jour).\n' +
        'Rédige aussi un "briefing" de 1-2 phrases, ton de secrétaire, en français.\n' +
        'Réponds STRICTEMENT en JSON, sans texte autour, selon ce schéma :\n' +
        '{"briefing": string, "items": [{"id": string, "title": string, "date": "YYYY-MM-DD", ' +
        '"start": string|null, "allDay": boolean, "location": string|null, "category": string, ' +
        '"categoryLabel": string|null, "importance": number, "note": string|null, "detail": string}], ' +
        '"judgedAt": string}';

    const lines = events.map(
        (e) =>
            `- [${e.id}] ${e.title} | ${e.date}${
                e.allDay ? ' (journée)' : ` ${e.start ?? ''}`
            }` +
            `${e.location ? ` | lieu: ${e.location}` : ''}` +
            `${e.attendees.length ? ` | avec: ${e.attendees.join(', ')}` : ''}`,
    );
    const user =
        `Date/heure actuelle : ${now.toISOString()}\n` +
        `Événements (${events.length}) :\n${lines.join('\n')}`;

    return { system, user };
}

function clampImportance(v: unknown): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return 50;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function normCategory(v: unknown): AgendaCategory {
    return CATEGORIES.includes(v as AgendaCategory)
        ? (v as AgendaCategory)
        : 'autre';
}

function normDetail(v: unknown): AgendaDetail {
    return (DETAILS as readonly string[]).includes(v as string)
        ? (v as AgendaDetail)
        : 'normal';
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}
function strOrNull(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Extrait le 1er objet JSON d'un texte LLM (tolère fences / préambule). */
function extractJson(text: string): unknown {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

export function parseJudgment(llmText: string): AgendaData | null {
    const raw = extractJson(llmText);
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (!Array.isArray(o.items)) return null;

    const items: AgendaItem[] = (o.items as unknown[]).map((it) => {
        const e = (it ?? {}) as Record<string, unknown>;
        const category = normCategory(e.category);
        return {
            id: str(e.id),
            title: str(e.title) || '(Sans titre)',
            date: str(e.date),
            start: typeof e.start === 'string' ? e.start : null,
            allDay: e.allDay === true,
            location: strOrNull(e.location),
            category,
            categoryLabel:
                category === 'autre'
                    ? strOrNull(e.categoryLabel) ?? strOrNull(e.category)
                    : null,
            importance: clampImportance(e.importance),
            note: strOrNull(e.note),
            detail: normDetail(e.detail),
        };
    });

    return {
        briefing: str(o.briefing),
        items,
        judgedAt: str(o.judgedAt) || new Date().toISOString(),
    };
}

export function eventsHash(events: AgendaEvent[]): string {
    const key = events
        .map(
            (e) =>
                `${e.id}|${e.title}|${e.date}|${e.start ?? ''}|${e.allDay}|${
                    e.location ?? ''
                }|${e.attendees.join(',')}`,
        )
        .sort()
        .join('\n');
    return createHash('sha1').update(key).digest('hex');
}

// ── Récupération des événements ────────────────────────────────────────────────

type CallTool = (
    name: string,
    args?: Record<string, unknown>,
) => Promise<unknown>;

const HORIZON_DAYS = 60;

function ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

/** Récupère et normalise les événements aujourd'hui → +60 j via get_schedule. */
export async function fetchAgendaEvents(
    callTool: CallTool,
    now: Date,
): Promise<AgendaEvent[]> {
    const startDate = ymd(now);
    const end = new Date(now.getTime() + HORIZON_DAYS * 86_400_000);
    const endDate = ymd(end);

    const res = await callTool('get_schedule', {
        startDate,
        endDate,
        maxResults: 100,
    });
    if (!isObj(res) || !Array.isArray(res.days)) return [];

    const out: AgendaEvent[] = [];
    for (const day of res.days as Array<Record<string, unknown>>) {
        const events = Array.isArray(day.events) ? day.events : [];
        for (const ev of events as Array<Record<string, unknown>>) {
            if (ev.cancelled === true) continue;
            out.push({
                id: str(ev.id) || `${str(day.date)}-${str(ev.title)}`,
                title: str(ev.title) || '(Sans titre)',
                date: str(ev.date) || str(day.date),
                start: typeof ev.start === 'string' ? ev.start : null,
                allDay: ev.all_day === true,
                location: strOrNull(ev.location),
                attendees: Array.isArray(ev.attendees)
                    ? (ev.attendees as unknown[])
                          .map((a) =>
                              isObj(a)
                                  ? str((a as Record<string, unknown>).name)
                                  : str(a),
                          )
                          .filter(Boolean)
                    : [],
            });
        }
    }
    return out;
}

// ── Service caché ──────────────────────────────────────────────────────────────

export interface AgendaSecretaryDeps {
    callTool: CallTool;
    complete: (system: string, user: string) => Promise<string>;
    ttlMs?: number;
}

const DEFAULT_TTL_MS = 30 * 60_000;

export class AgendaSecretary {
    private cache: { hash: string; data: AgendaData; at: number } | null = null;
    private inflight: Promise<AgendaData | null> | null = null;
    private readonly ttlMs: number;

    constructor(private deps: AgendaSecretaryDeps) {
        this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    }

    async getAgenda(now: Date = new Date()): Promise<AgendaData | null> {
        if (this.inflight) return this.inflight;
        this.inflight = this.compute(now).finally(() => {
            this.inflight = null;
        });
        return this.inflight;
    }

    private async compute(now: Date): Promise<AgendaData | null> {
        let events: AgendaEvent[];
        try {
            events = await fetchAgendaEvents(this.deps.callTool, now);
        } catch {
            return null;
        }
        const hash = eventsHash(events);

        if (
            this.cache &&
            this.cache.hash === hash &&
            now.getTime() - this.cache.at < this.ttlMs
        ) {
            return this.cache.data;
        }

        const { system, user } = buildSecretaryPrompt(events, now);
        let data: AgendaData | null;
        try {
            data = parseJudgment(await this.deps.complete(system, user));
        } catch {
            return null; // LLM KO → null, pas de mise en cache
        }
        if (!data) return null; // JSON invalide → null, pas de mise en cache

        this.cache = { hash, data, at: now.getTime() };
        return data;
    }
}
