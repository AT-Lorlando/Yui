import { eventMode, type AgendaEvent } from '../../agendaSecretary';

// Gabarits du point du matin : purs, sans LLM. Réutilisés par les rappels.

export interface Rendered {
    notif: string;
    spoken: string;
}

const MAX_LISTED = 6;
const EXCLUDED_CALENDAR_RE = /f[ée]ri|num[ée]ros de semaine/i;

const UNITS = [
    'zéro',
    'un',
    'deux',
    'trois',
    'quatre',
    'cinq',
    'six',
    'sept',
    'huit',
    'neuf',
    'dix',
    'onze',
    'douze',
    'treize',
    'quatorze',
    'quinze',
    'seize',
    'dix-sept',
    'dix-huit',
    'dix-neuf',
];
const TENS: Record<number, string> = {
    2: 'vingt',
    3: 'trente',
    4: 'quarante',
    5: 'cinquante',
};

/** 0–59 en lettres (français standard). */
export function numberFr(n: number): string {
    if (!Number.isInteger(n) || n < 0 || n > 59) return String(n);
    if (n < 20) return UNITS[n];
    const t = Math.floor(n / 10);
    const u = n % 10;
    if (u === 0) return TENS[t];
    return `${TENS[t]}${u === 1 ? ' et ' : '-'}${UNITS[u]}`;
}

function parseHhmm(hhmm: string): { h: number; m: number } {
    const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
    return { h: h || 0, m: m || 0 };
}

/** '14:00' → '14h', '09:05' → '9h05'. */
export function hourNotif(hhmm: string): string {
    const { h, m } = parseHhmm(hhmm);
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

/** '14:30' → 'quatorze heures trente', '12:00' → 'midi'. */
export function hourSpoken(hhmm: string): string {
    const { h, m } = parseHhmm(hhmm);
    const mins = m === 0 ? '' : ` ${numberFr(m)}`;
    if (h === 12) return `midi${mins}`;
    if (h === 0) return `minuit${mins}`;
    const word =
        h === 1
            ? 'une heure'
            : h === 21
            ? 'vingt et une heures'
            : `${numberFr(h)} heures`;
    return `${word}${mins}`;
}

function cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function coversDay(e: AgendaEvent, date: string): boolean {
    return e.date <= date && (e.endDate ?? e.date) >= date;
}

export function morningBrief(date: string, events: AgendaEvent[]): Rendered {
    const kept = events.filter(
        (e) => !(e.calendar && EXCLUDED_CALENDAR_RE.test(e.calendar)),
    );
    const timed = kept
        .filter((e) => !e.allDay && e.start && e.date === date)
        .sort((a, b) => (a.start as string).localeCompare(b.start as string));
    const allDay = kept.filter((e) => e.allDay && coversDay(e, date));

    let notif: string;
    let spoken: string;

    if (timed.length === 0) {
        notif = "Rien à l'agenda ajd";
        spoken = "Rien à l'agenda aujourd'hui.";
    } else {
        const modes = timed.map((e) => eventMode(e));
        const rdv = modes.some((m) => m === 'onsite');
        const n = timed.length;
        const nounNotif = rdv ? 'rdv' : n > 1 ? 'réunions' : 'réunion';
        const nounSpoken = rdv ? 'rendez-vous' : n > 1 ? 'réunions' : 'réunion';
        const count = n === 1 && !rdv ? 'une' : numberFr(n);

        const listed = timed.slice(0, MAX_LISTED);
        const extra = n - listed.length;
        const notifItems = listed.map((e, i) => {
            const label =
                modes[i] === 'visio'
                    ? ' (visio)'
                    : modes[i] === 'onsite'
                    ? ' (sur site)'
                    : '';
            return `${hourNotif(e.start as string)} : ${e.title}${label}`;
        });
        const spokenItems = listed.map((e, i) => {
            const label =
                modes[i] === 'visio'
                    ? ', en visio'
                    : modes[i] === 'onsite'
                    ? ', sur site'
                    : '';
            return `${cap(hourSpoken(e.start as string))}, ${e.title}${label}.`;
        });

        notif = `${n} ${nounNotif} ajd — ${notifItems.join(' · ')}`;
        if (extra > 0) notif += ` · +${extra}`;
        spoken = `${cap(count)} ${nounSpoken} aujourd'hui. ${spokenItems.join(
            ' ',
        )}`;
        if (extra > 0)
            spoken +=
                extra === 1
                    ? ' Et un autre.'
                    : ` Et ${numberFr(extra)} autres.`;
    }

    if (allDay.length > 0) {
        const titles = allDay.map((e) => e.title).join(', ');
        notif += ` · ajd aussi : ${titles}`;
        spoken += ` Aujourd'hui aussi : ${titles}.`;
    }
    return { notif, spoken };
}
