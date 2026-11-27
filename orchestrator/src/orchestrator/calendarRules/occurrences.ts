import { addDays } from '../schedule/dayPlan';
import { isWorkday, weekdayOf } from '../schedule/holidays';
import { CalendarRule, Shift } from './model';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Nombre de jours du mois `m` (1-12) de l'année `y`. */
function monthLength(y: number, m: number): number {
    return new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
}

function prevWorkday(date: string): string {
    let d = date;
    while (!isWorkday(d)) d = addDays(d, -1);
    return d;
}

function nextWorkday(date: string): string {
    let d = date;
    while (!isWorkday(d)) d = addDays(d, 1);
    return d;
}

function lastWorkdayOf(y: number, m: number): string {
    return prevWorkday(ymd(y, m, monthLength(y, m)));
}

function shifted(date: string, shift: Shift): string {
    if (shift === 'none' || isWorkday(date)) return date;
    return shift === 'after' ? nextWorkday(date) : prevWorkday(date);
}

function mondayOf(date: string): string {
    return addDays(date, -((weekdayOf(date) + 6) % 7));
}

function daysBetween(a: string, b: string): number {
    return Math.round(
        (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) /
            86_400_000,
    );
}

function monthOccurrences(r: CalendarRule, y: number, m: number): string[] {
    switch (r.kind) {
        case 'last-workday-month':
            return [lastWorkdayOf(y, m)];
        case 'first-workday-month':
            return [nextWorkday(ymd(y, m, 1))];
        case 'workdays-before-month-end': {
            let d = lastWorkdayOf(y, m);
            for (let i = 0; i < (r.n ?? 1); i++)
                d = prevWorkday(addDays(d, -1));
            return [d];
        }
        case 'day-of-month': {
            const day = Math.min(r.day ?? 1, monthLength(y, m));
            return [shifted(ymd(y, m, day), r.shift ?? 'before')];
        }
        case 'nth-weekday-month': {
            const len = monthLength(y, m);
            const hits: string[] = [];
            for (let d = 1; d <= len; d++)
                if (weekdayOf(ymd(y, m, d)) === r.weekday)
                    hits.push(ymd(y, m, d));
            const pick =
                r.n === -1 ? hits[hits.length - 1] : hits[(r.n ?? 1) - 1];
            return pick ? [pick] : [];
        }
        case 'last-workday-quarter':
            return m % 3 === 0 ? [lastWorkdayOf(y, m)] : [];
        case 'yearly': {
            if (m !== r.month) return [];
            const day = Math.min(r.day ?? 1, monthLength(y, m));
            return [shifted(ymd(y, m, day), r.shift ?? 'before')];
        }
        default:
            return [];
    }
}

function weeklyOccurrences(
    r: CalendarRule,
    from: string,
    to: string,
): string[] {
    const anchor = r.anchor ?? r.start;
    const anchorMonday = mondayOf(anchor);
    const n = r.n ?? 1;
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
        if (d < anchor || !r.weekdays?.includes(weekdayOf(d))) continue;
        const weeks = Math.round(daysBetween(anchorMonday, mondayOf(d)) / 7);
        if (weeks % n === 0) out.push(d);
    }
    return out;
}

/** Dates (triées, uniques, bornes incluses) où la règle tombe entre `from` et `to`. */
export function occurrences(
    rule: CalendarRule,
    from: string,
    to: string,
): string[] {
    const lo = from > rule.start ? from : rule.start;
    const hi = rule.until && rule.until < to ? rule.until : to;
    if (lo > hi) return [];

    if (rule.kind === 'every-n-weeks') return weeklyOccurrences(rule, lo, hi);

    const found = new Set<string>();
    // Un mois avant et un mois après : un décalage peut franchir la frontière.
    let y = Number(lo.slice(0, 4));
    let m = Number(lo.slice(5, 7)) - 1;
    if (m < 1) {
        m = 12;
        y -= 1;
    }
    const endY = Number(hi.slice(0, 4));
    const endM = Number(hi.slice(5, 7));
    const endIdx = endY * 12 + endM + 1;
    while (y * 12 + m <= endIdx) {
        for (const d of monthOccurrences(rule, y, m))
            if (d >= lo && d <= hi) found.add(d);
        m += 1;
        if (m > 12) {
            m = 1;
            y += 1;
        }
    }
    return [...found].sort();
}

/** Les `count` prochaines occurrences à partir de `today` (inclus). */
export function nextOccurrences(
    rule: CalendarRule,
    today: string,
    count: number,
): string[] {
    const out: string[] = [];
    let from = today;
    // Horizon de 10 ans, par tranches d'un an.
    for (let i = 0; i < 10 && out.length < count; i++) {
        const to = addDays(from, 365);
        out.push(
            ...occurrences(rule, from, to).filter((d) => !out.includes(d)),
        );
        from = addDays(to, 1);
    }
    return out.slice(0, count);
}
