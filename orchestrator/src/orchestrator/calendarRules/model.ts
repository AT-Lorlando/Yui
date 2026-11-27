import { randomBytes } from 'crypto';

export type RuleKind =
    | 'last-workday-month'
    | 'first-workday-month'
    | 'workdays-before-month-end'
    | 'day-of-month'
    | 'nth-weekday-month'
    | 'every-n-weeks'
    | 'last-workday-quarter'
    | 'yearly';
export type Shift = 'before' | 'after' | 'none';

export interface CalendarRule {
    id: string;
    title: string;
    kind: RuleKind;
    enabled: boolean;
    allDay: boolean;
    time?: string;
    durationMin?: number;
    calendarId: string;
    description?: string;
    start: string;
    until?: string;
    n?: number;
    day?: number;
    month?: number;
    weekday?: number;
    weekdays?: number[];
    anchor?: string;
    shift?: Shift;
}

export const RULE_KINDS: RuleKind[] = [
    'last-workday-month',
    'first-workday-month',
    'workdays-before-month-end',
    'day-of-month',
    'nth-weekday-month',
    'every-n-weeks',
    'last-workday-quarter',
    'yearly',
];

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRealDate(s: unknown): s is string {
    if (typeof s !== 'string' || !YMD.test(s)) return false;
    const d = new Date(`${s}T12:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function int(v: unknown, min: number, max: number): number | null {
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
        ? v
        : null;
}

function slug(title: string): string {
    const s = title
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '');
    return s || 'regle';
}

function genId(title: string): string {
    let suffix = '';
    while (suffix.length < 6)
        suffix += randomBytes(8).readBigUInt64BE().toString(36);
    return `${slug(title)}-${suffix.slice(0, 6)}`;
}

function readShift(v: unknown): Shift {
    if (v === undefined || v === null) return 'before';
    if (v === 'before' || v === 'after' || v === 'none') return v;
    throw new Error(`Décalage invalide : ${String(v)}`);
}

export function normalizeRule(
    raw: unknown,
    opts: { id?: string; today: string },
): CalendarRule {
    if (!isObj(raw)) throw new Error('Règle invalide');

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) throw new Error('Titre requis');
    if (title.length > 120) throw new Error('Titre trop long (120 max)');

    const kind = raw.kind as RuleKind;
    if (!RULE_KINDS.includes(kind))
        throw new Error(`Type inconnu : ${String(raw.kind)}`);

    const allDay = raw.allDay === undefined ? true : raw.allDay !== false;

    const calendarId =
        raw.calendarId === undefined ? 'primary' : raw.calendarId;
    if (typeof calendarId !== 'string' || !calendarId.trim())
        throw new Error('Agenda invalide');

    const start = raw.start === undefined ? opts.today : raw.start;
    if (!isRealDate(start)) throw new Error(`Date invalide : ${String(start)}`);

    const out: CalendarRule = {
        id:
            typeof opts.id === 'string' && opts.id
                ? opts.id
                : typeof raw.id === 'string' && raw.id
                ? raw.id
                : genId(title),
        title,
        kind,
        enabled: raw.enabled !== false,
        allDay,
        calendarId: calendarId.trim(),
        start,
    };

    if (!allDay) {
        if (typeof raw.time !== 'string' || !HHMM.test(raw.time))
            throw new Error(`Heure invalide : ${String(raw.time ?? '')}`);
        out.time = raw.time;
        const dur =
            raw.durationMin === undefined ? 60 : int(raw.durationMin, 5, 1440);
        if (dur === null) throw new Error('Durée invalide');
        out.durationMin = dur;
    }

    if (raw.description !== undefined && raw.description !== null) {
        if (typeof raw.description !== 'string' || raw.description.length > 500)
            throw new Error('Description trop longue (500 max)');
        if (raw.description.trim()) out.description = raw.description;
    }

    if (raw.until !== undefined && raw.until !== null) {
        if (!isRealDate(raw.until))
            throw new Error(`Date invalide : ${String(raw.until)}`);
        if (raw.until < start) throw new Error('Fin avant le début');
        out.until = raw.until;
    }

    switch (kind) {
        case 'workdays-before-month-end': {
            const n = int(raw.n, 1, 15);
            if (n === null)
                throw new Error('Nombre de jours ouvrés invalide (1 à 15)');
            out.n = n;
            break;
        }
        case 'day-of-month': {
            const day = int(raw.day, 1, 31);
            if (day === null) throw new Error('Jour invalide (1 à 31)');
            out.day = day;
            out.shift = readShift(raw.shift);
            break;
        }
        case 'nth-weekday-month': {
            const n = raw.n === -1 ? -1 : int(raw.n, 1, 5);
            if (n === null) throw new Error('Rang invalide (1 à 5 ou -1)');
            const weekday = int(raw.weekday, 0, 6);
            if (weekday === null)
                throw new Error('Jour de semaine invalide (0 à 6)');
            out.n = n;
            out.weekday = weekday;
            break;
        }
        case 'every-n-weeks': {
            const n = int(raw.n, 1, 8);
            if (n === null)
                throw new Error('Intervalle invalide (1 à 8 semaines)');
            if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0)
                throw new Error('Jours de semaine requis');
            const wds = new Set<number>();
            for (const w of raw.weekdays) {
                const v = int(w, 0, 6);
                if (v === null)
                    throw new Error('Jour de semaine invalide (0 à 6)');
                wds.add(v);
            }
            const anchor = raw.anchor === undefined ? start : raw.anchor;
            if (!isRealDate(anchor))
                throw new Error(`Date invalide : ${String(anchor)}`);
            out.n = n;
            out.weekdays = [...wds].sort((a, b) => a - b);
            out.anchor = anchor;
            break;
        }
        case 'yearly': {
            const month = int(raw.month, 1, 12);
            if (month === null) throw new Error('Mois invalide (1 à 12)');
            const day = int(raw.day, 1, 31);
            if (day === null) throw new Error('Jour invalide (1 à 31)');
            out.month = month;
            out.day = day;
            out.shift = readShift(raw.shift);
            break;
        }
        default:
            break;
    }
    return out;
}
