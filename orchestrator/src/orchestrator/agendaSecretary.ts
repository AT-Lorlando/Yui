import { createHash } from 'crypto';
import { checkComposed } from './proactive/brief/compose';

export interface AgendaEvent {
    id: string;
    title: string;
    date: string; // YYYY-MM-DD (jour de début)
    endDate: string | null; // YYYY-MM-DD dernier jour inclus si multi-jour, sinon null
    start: string | null; // "HH:MM" ou null (journée entière)
    allDay: boolean;
    location: string | null;
    description: string | null; // note/description de l'event (contexte pour le LLM)
    durationMin: number | null; // durée en minutes (events horaires), sinon null
    attendees: string[];
}

/** Nombre de jours (inclus) entre deux dates YYYY-MM-DD ; >= 1. */
function spanDays(start: string, end: string): number {
    const d1 = new Date(start + 'T00:00:00Z').getTime();
    const d2 = new Date(end + 'T00:00:00Z').getTime();
    if (!Number.isFinite(d1) || !Number.isFinite(d2)) return 1;
    return Math.max(1, Math.round((d2 - d1) / 86_400_000) + 1);
}

export type AgendaCategory =
    | 'meeting-pro'
    | 'call'
    | 'afterwork'
    | 'weekend'
    | 'vacation'
    | 'holiday'
    | 'perso'
    | 'autre';

const CATEGORIES: AgendaCategory[] = [
    'meeting-pro',
    'call',
    'afterwork',
    'weekend',
    'vacation',
    'holiday',
    'perso',
    'autre',
];
const DETAILS = ['full', 'normal', 'minimal'] as const;
export type AgendaDetail = (typeof DETAILS)[number];

export interface AgendaItem {
    id: string;
    title: string;
    date: string;
    endDate: string | null; // dernier jour inclus si multi-jour (durée des vacances), sinon null
    durationMin: number | null; // durée en minutes (events horaires), sinon null
    start: string | null;
    allDay: boolean;
    location: string | null;
    category: AgendaCategory;
    categoryLabel: string | null;
    importance: number; // 0-100
    note: string | null;
    detail: AgendaDetail;
    countdown: boolean; // affichage "dans X jours" (événement attendu : fête, anniv, vacances…)
}

export interface AgendaData {
    briefing: string;
    items: AgendaItem[];
    judgedAt: string; // ISO
}

const TAXONOMY_LINE = CATEGORIES.join(' | ');

// ── Catégorisation déterministe ────────────────────────────────────────────────
// Les règles tournent sur le titre + la description repliés (minuscules, sans
// accents) : le LLM ne peut pas contredire un résultat « sûr », il ne tranche
// que les cas incertains (réunion pro / call, ou rien ne colle).

function fold(s: string): string {
    return s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

const HOLIDAY_RE =
    /ferie|assomption|toussaint|\bnoel\b|1er mai|8 mai|14 juillet|11 novembre|\bpaques\b|ascension|pentecote/;
const VACATION_RE = /\bvacances|\bconges?\b|\bsejour|\bvoyage/;
// Frontière de mot fermante sur « kine » : « Kinéis » (une entreprise) n'est
// pas un rendez-vous chez le kiné.
const PERSO_RE =
    /\bpsy|\bmedecin|\bdentiste|\bkine\b|\bcoiffeur|\bosteo|\bsport|\bsalle\b|\bveterinaire/;
const AFTERWORK_RE = /afterwork|\bapero|\bsoiree/;
const CALL_RE = /\bcall\b|\bvisio|\bteams\b|\bmeet\b|\bzoom\b/;
const MEETING_RE =
    /\bentretien|\breunion|\bmeeting|\bpoint\b|\bcomite|\bdemo\b|\breview\b/;

// Un participant dont l'adresse n'est pas chez un fournisseur grand public
// signe une réunion professionnelle.
const PERSONAL_MAIL_DOMAINS = new Set([
    'gmail.com',
    'googlemail.com',
    'hotmail.com',
    'hotmail.fr',
    'outlook.com',
    'outlook.fr',
    'live.com',
    'live.fr',
    'yahoo.com',
    'yahoo.fr',
    'icloud.com',
    'me.com',
    'free.fr',
    'orange.fr',
    'wanadoo.fr',
    'sfr.fr',
    'laposte.net',
    'proton.me',
    'protonmail.com',
]);

function hasProAttendee(attendees: string[]): boolean {
    return attendees.some((a) => {
        const m = /@([^\s>]+)/.exec(a);
        return m ? !PERSONAL_MAIL_DOMAINS.has(m[1].toLowerCase()) : false;
    });
}

/** Jour de la semaine UTC (0 = dimanche, 6 = samedi) d'une date YYYY-MM-DD. */
function weekday(ymd: string): number {
    return new Date(ymd + 'T00:00:00Z').getUTCDay();
}

export function categorizeEvent(
    e: AgendaEvent,
    _now: Date,
): { category: AgendaCategory; sure: boolean } {
    const text = fold(`${e.title} ${e.description ?? ''}`);
    const days = e.endDate ? spanDays(e.date, e.endDate) : 1;
    const sure = (category: AgendaCategory) => ({ category, sure: true });

    // Un férié est un jour ; un bloc journée entière de plusieurs jours
    // (« Vacances de Noël ») est du temps libre, quel que soit le mot. Un
    // événement horaire étalé sur plusieurs jours n'en est pas un.
    const block = e.allDay && days >= 3;
    if (!block && HOLIDAY_RE.test(text)) return sure('holiday');
    if (block || VACATION_RE.test(text)) return sure('vacation');
    const wd = weekday(e.date);
    if (e.allDay && (wd === 6 || (wd === 0 && days === 1))) {
        return sure('weekend');
    }
    if (PERSO_RE.test(text)) return sure('perso');
    if (AFTERWORK_RE.test(text)) return sure('afterwork');
    if (CALL_RE.test(text)) return sure('call');
    if (MEETING_RE.test(text) || hasProAttendee(e.attendees)) {
        return { category: 'meeting-pro', sure: false };
    }
    return { category: 'autre', sure: false };
}

export function buildSecretaryPrompt(
    events: AgendaEvent[],
    now: Date,
): { system: string; user: string } {
    const system =
        'Tu es la secrétaire personnelle de Jérémy. On te donne ses événements ' +
        "d'agenda des deux prochains mois, chacun avec un id. Les faits (titre, date, " +
        "heure, lieu) viennent de l'agenda : tu ne les renvoies pas, tu ANNOTES chaque " +
        'événement par son id :\n' +
        '- category : UNIQUEMENT pour les événements marqués « catégorie : à choisir », ' +
        `parmi : ${TAXONOMY_LINE} ("autre" si rien ne colle). Pour ceux marqués « fixée », ` +
        'la catégorie est déjà décidée : ne renvoie pas de category (elle serait ignorée).\n' +
        '- importance : entier 0-100 (un call client > un afterwork > un week-end off). ' +
        'Les réunions professionnelles hors de la semaine analysée — la semaine en cours, ' +
        'étendue à la semaine prochaine UNIQUEMENT si on est vendredi, samedi ou dimanche — ' +
        'sont du bruit : importance 20 au plus et detail "minimal".\n' +
        "- note : courte phrase utile de secrétaire, ou null. N'y mets aucun nom, chiffre " +
        'ou lieu absent de l\'événement lui-même (sa description "desc:" compte) — une note ' +
        'qui invente est supprimée.\n' +
        '- detail : "full" (heure+lieu+participants+note), "normal" (heure+lieu), "minimal" (titre+jour).\n' +
        "- countdown : true pour un événement qu'on attend (anniversaire, fête, mariage, " +
        'concert…) ; false pour la routine (rendez-vous, réunion, call).\n' +
        'Rédige aussi un "briefing" de 1-2 phrases, ton de secrétaire, en français, ' +
        'avec les mêmes règles que la note : rien qui ne soit dans les événements.\n' +
        'Réponds STRICTEMENT en JSON, sans texte autour, selon ce schéma :\n' +
        '{"briefing": string, "items": [{"id": string, "category"?: string, ' +
        '"importance": number, "note": string|null, "detail": string, "countdown": boolean}]}';

    const lines = events.map((e) => {
        const span =
            e.endDate && e.endDate !== e.date
                ? ` → ${e.endDate} (${spanDays(e.date, e.endDate)} jours)`
                : '';
        const when = e.allDay ? `${span} (journée)` : ` ${e.start ?? ''}`;
        const rule = categorizeEvent(e, now);
        const category = rule.sure
            ? `${rule.category} (fixée)`
            : `à choisir (suggestion : ${rule.category})`;
        return (
            `- [${e.id}] ${e.title} | ${e.date}${when}` +
            `${e.location ? ` | lieu: ${e.location}` : ''}` +
            `${
                e.attendees.length ? ` | avec: ${e.attendees.join(', ')}` : ''
            }` +
            `${
                e.description ? ` | desc: ${e.description.slice(0, 120)}` : ''
            }` +
            ` | catégorie : ${category}`
        );
    });
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

/** Nombres qu'une phrase peut légitimement tirer d'une date YYYY-MM-DD :
 *  année, mois et jour, avec et sans zéro initial (« le 5 juillet »). */
function dateNumbers(ymd: string): string[] {
    const [y, m, d] = ymd.split('-');
    return [y, m, d, String(Number(m)), String(Number(d))].filter(Boolean);
}

/** Chaînes dont les jetons (chiffres, noms propres) sont tolérés dans une
 *  note ou un briefing : les faits des événements eux-mêmes, plus les nombres
 *  qu'on en dérive (heure « 10h », durée « 1h30 », « 15 jours », nombre
 *  d'événements). Tout le reste est une invention. */
function allowedTokensFor(events: AgendaEvent[]): string[] {
    const out: string[] = [];
    for (const e of events) {
        out.push(e.title, ...e.attendees, ...dateNumbers(e.date));
        if (e.location) out.push(e.location);
        if (e.description) out.push(e.description);
        if (e.endDate) {
            out.push(
                ...dateNumbers(e.endDate),
                String(spanDays(e.date, e.endDate)),
            );
        }
        if (e.start) out.push(e.start, ...e.start.split(':'));
        if (e.durationMin != null) {
            out.push(
                String(e.durationMin),
                String(Math.floor(e.durationMin / 60)),
                String(e.durationMin % 60),
            );
        }
    }
    out.push(String(events.length));
    return out;
}

/** Garde anti-invention d'un texte LLM (même règle que le brief composé) :
 *  un chiffre ou un nom propre absent de `allowed` → texte refusé (null). */
export function checkText(
    text: string | null,
    allowed: string[],
): string | null {
    if (!text) return null;
    const res = checkComposed(text, [], allowed);
    return res.ok && res.text.length > 0 ? res.text : null;
}

/** Un item est reconstruit depuis son événement source ; la réponse du LLM
 *  n'apporte que des annotations. Sans réponse : annotations neutres. */
function buildItem(
    src: AgendaEvent,
    reply: Record<string, unknown> | undefined,
    now: Date,
): AgendaItem {
    const rule = categorizeEvent(src, now);
    let category = rule.category;
    let categoryLabel: string | null = null;
    const rawCategory = reply ? strOrNull(reply.category) : null;
    if (rawCategory && !rule.sure) {
        category = normCategory(rawCategory);
        // Une catégorie libre (hors taxonomie) devient « autre » et sert de libellé.
        if (category === 'autre' && rawCategory !== 'autre') {
            categoryLabel = rawCategory;
        }
    }
    return {
        id: src.id,
        title: src.title,
        date: src.date,
        endDate: src.endDate,
        durationMin: src.durationMin,
        start: src.start,
        allDay: src.allDay,
        location: src.location,
        category,
        categoryLabel,
        importance: reply ? clampImportance(reply.importance) : 50,
        note: reply
            ? checkText(strOrNull(reply.note), allowedTokensFor([src]))
            : null,
        detail: reply ? normDetail(reply.detail) : 'normal',
        // Vacances / fériés se décomptent toujours ; le reste sur avis du LLM.
        countdown:
            reply?.countdown === true ||
            category === 'vacation' ||
            category === 'holiday',
    };
}

export function parseJudgment(
    llmText: string,
    sourceEvents: AgendaEvent[],
): AgendaData | null {
    const raw = extractJson(llmText);
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (!Array.isArray(o.items)) return null;

    // Réponses indexées par id : un id inconnu de la source est ignoré.
    const replies = new Map<string, Record<string, unknown>>();
    for (const it of o.items as unknown[]) {
        if (isObj(it) && typeof it.id === 'string') replies.set(it.id, it);
    }
    const now = new Date();
    const items = sourceEvents.map((src) =>
        buildItem(src, replies.get(src.id), now),
    );

    return {
        briefing:
            checkText(strOrNull(o.briefing), allowedTokensFor(sourceEvents)) ??
            '',
        items,
        judgedAt: now.toISOString(),
    };
}

export function eventsHash(events: AgendaEvent[]): string {
    const key = events
        .map(
            (e) =>
                `${e.id}|${e.title}|${e.date}|${e.endDate ?? ''}|${
                    e.start ?? ''
                }|${e.allDay}|${e.location ?? ''}|${
                    e.description ?? ''
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
                endDate: strOrNull(ev.end_date),
                start: typeof ev.start === 'string' ? ev.start : null,
                allDay: ev.all_day === true,
                location: strOrNull(ev.location),
                description: strOrNull(ev.note),
                durationMin:
                    typeof ev.duration_min === 'number'
                        ? ev.duration_min
                        : null,
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

// Un appel LLM sans borne héritait du timeout du client OpenAI (10 min,
// retries compris) : UN aller-retour accroché gelait la tuile agenda en
// « pending » jusqu'à ~30 min (vécu le 07/09). Au-delà de cette borne, on
// abandonne → le front affiche le repli brut, et on retente au prochain
// rafraîchissement.
const LLM_TIMEOUT_MS = Number(process.env.AGENDA_LLM_TIMEOUT_MS ?? 60_000);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error(`agenda LLM timeout (${ms} ms)`)),
            ms,
        );
        t.unref?.();
        promise.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}

export class AgendaSecretary {
    private cache: { hash: string; data: AgendaData; at: number } | null = null;
    private inflight: Promise<AgendaData | null> | null = null;
    private readonly ttlMs: number;

    constructor(private deps: AgendaSecretaryDeps) {
        this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    }

    /**
     * Une analyse est en cours et aucun résultat n'est encore disponible à afficher
     * (premier calcul LLM long). Le front affiche alors un loader plutôt que le repli.
     */
    isPending(): boolean {
        return this.inflight !== null && this.cache === null;
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
            data = parseJudgment(
                await withTimeout(
                    this.deps.complete(system, user),
                    LLM_TIMEOUT_MS,
                ),
                events,
            );
        } catch {
            return null; // LLM KO ou trop lent → repli brut, pas de cache
        }
        if (!data) return null; // JSON invalide → null, pas de mise en cache

        this.cache = { hash, data, at: now.getTime() };
        return data;
    }
}
