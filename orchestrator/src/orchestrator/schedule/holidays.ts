// Jours fériés français et jours ouvrés, calculés localement (pas d'appel
// réseau, pas de dépendance à l'agenda « Jours fériés »).

const cache = new Map<number, Map<string, string>>();

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

function ymdUtc(d: Date): string {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
        d.getUTCDate(),
    )}`;
}

/** Dimanche de Pâques (algorithme grégorien anonyme, Meeus/Jones/Butcher). */
function easterSunday(year: number): Date {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day, 12));
}

function plusDays(d: Date, n: number): string {
    return ymdUtc(new Date(d.getTime() + n * 86_400_000));
}

/** Date `YYYY-MM-DD` → libellé du férié, pour l'année donnée. */
export function frenchHolidays(year: number): Map<string, string> {
    const hit = cache.get(year);
    if (hit) return hit;
    const easter = easterSunday(year);
    const y = String(year);
    const out = new Map<string, string>([
        [`${y}-01-01`, "Jour de l'an"],
        [plusDays(easter, 1), 'Lundi de Pâques'],
        [`${y}-05-01`, 'Fête du Travail'],
        [`${y}-05-08`, 'Victoire 1945'],
        [plusDays(easter, 39), 'Ascension'],
        [plusDays(easter, 50), 'Lundi de Pentecôte'],
        [`${y}-07-14`, 'Fête nationale'],
        [`${y}-08-15`, 'Assomption'],
        [`${y}-11-01`, 'Toussaint'],
        [`${y}-11-11`, 'Armistice'],
        [`${y}-12-25`, 'Noël'],
    ]);
    cache.set(year, out);
    return out;
}

export function holidayName(date: string): string | null {
    const year = Number(date.slice(0, 4));
    if (!Number.isFinite(year)) return null;
    return frenchHolidays(year).get(date) ?? null;
}

/** 0 = dimanche … 6 = samedi, calculé à midi UTC (insensible au fuseau). */
export function weekdayOf(date: string): number {
    return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Lundi–vendredi hors férié. */
export function isWorkday(date: string): boolean {
    const wd = weekdayOf(date);
    return wd >= 1 && wd <= 5 && holidayName(date) === null;
}
