import { eventMode, type AgendaEvent } from '../../agendaSecretary';
import { eventsOn } from './feeds';
import {
    hourNotif,
    hourSpoken,
    morningBrief,
    numberFr,
    numberFrFem,
    type Rendered,
} from './format';
import type { ParcelInfo } from './types';

// Gabarits des rappels : purs, déterministes, sans LLM.

function cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Suffixe de lieu : sur site avec lieu → lieu ; visio/inconnu → visio. */
function placeNotif(e: AgendaEvent): string {
    const mode = eventMode(e);
    if (mode === 'onsite') return e.location ? ` (${e.location})` : '';
    return ' (visio)';
}

function placeSpoken(e: AgendaEvent): string {
    const mode = eventMode(e);
    if (mode === 'onsite') return e.location ? `, ${e.location}` : '';
    return ', en visio';
}

/** Mails à traiter : le compte complet, au plus trois expéditeurs nommés. */
export interface MailSummary {
    count: number;
    names: string[];
}

function mailsText(mails: MailSummary): Rendered | null {
    const n = mails.count;
    if (n <= 0) return null;
    const shown = mails.names.slice(0, 3).join(', ');
    const names = shown ? ` : ${shown}` : '';
    const s = n > 1 ? 's' : '';
    return {
        notif: `${n} mail${s} à traiter${names}`,
        spoken: `${cap(numberFr(n))} mail${s} à traiter${names}.`,
    };
}

function minutesSpoken(n: number): string {
    return `${numberFrFem(n)} minute${n > 1 ? 's' : ''}`;
}

export function eveText(
    date: string,
    events: AgendaEvent[],
    parcels: ParcelInfo[],
    mails: MailSummary,
): Rendered {
    const evs = eventsOn(date, events);
    const firstIsTimed = !!(evs[0] && !evs[0].allDay && evs[0].start);
    const notifItems: string[] = [];
    const spokenItems: string[] = [];
    for (const e of evs) {
        if (e.allDay || !e.start) {
            notifItems.push(`${e.title} (journée)`);
            spokenItems.push(`${e.title}, toute la journée.`);
        } else {
            notifItems.push(`${hourNotif(e.start)} ${e.title}${placeNotif(e)}`);
            spokenItems.push(
                `${cap(hourSpoken(e.start))}, ${e.title}${placeSpoken(e)}.`,
            );
        }
    }
    for (const p of parcels.filter((x) => x.estimatedDate === date)) {
        notifItems.push(`Colis « ${p.label} » attendu`);
        spokenItems.push(`Colis « ${p.label} » attendu.`);
    }
    if (notifItems.length === 0) {
        notifItems.push("rien à l'agenda");
        spokenItems.push("rien à l'agenda.");
    }
    const m = mailsText(mails);
    if (m) {
        notifItems.push(m.notif);
        spokenItems.push(m.spoken);
    }
    return {
        notif: `Demain : ${notifItems.join(' · ')}`,
        spoken: `Demain : ${spokenItems
            .map((x, i) =>
                i === 0 && firstIsTimed
                    ? x.charAt(0).toLowerCase() + x.slice(1)
                    : x,
            )
            .join(' ')}`,
    };
}

export function imminentText(e: AgendaEvent, minutes: number): Rendered {
    return {
        notif: `Dans ${minutes} min : ${e.title}${placeNotif(e)}`,
        spoken: `Dans ${minutesSpoken(minutes)} : ${e.title}${placeSpoken(e)}.`,
    };
}

export function departText(
    firstEvent: AgendaEvent | null,
    weather: string | null,
    leadMin: number,
): Rendered {
    let notif = `Départ dans ${leadMin} min`;
    let spoken = `Départ dans ${minutesSpoken(leadMin)}.`;
    if (firstEvent && firstEvent.start) {
        const mode = eventMode(firstEvent);
        const labN = mode === 'onsite' ? ' (sur site)' : ' (visio)';
        const labS = mode === 'onsite' ? ', sur site' : ', en visio';
        notif += ` — 1er RDV ${hourNotif(firstEvent.start)} : ${
            firstEvent.title
        }${labN}`;
        spoken += ` Premier rendez-vous à ${hourSpoken(firstEvent.start)}, ${
            firstEvent.title
        }${labS}.`;
    }
    if (weather) {
        notif += ` · ${weather}`;
        spoken += ` Météo : ${weather}.`;
    }
    return { notif, spoken };
}

export function parcelText(p: ParcelInfo): Rendered {
    const base = `Colis « ${p.label} »`;
    let tail: string;
    switch (p.status) {
        case 'out_for_delivery':
            tail = " en livraison aujourd'hui";
            break;
        case 'delivered':
            tail = ' livré';
            break;
        case 'pickup_ready':
            tail = ' à retirer';
            break;
        case 'problem':
            tail = ' : problème de livraison';
            break;
        default:
            tail = " en cours d'acheminement";
    }
    return { notif: base + tail, spoken: `${base}${tail}.` };
}

export function morningText(
    date: string,
    events: AgendaEvent[],
    mails: MailSummary,
    postits: string[],
    notes: string[],
): Rendered {
    const brief = morningBrief(date, events);
    let notif = brief.notif;
    let spoken = brief.spoken;
    const m = mailsText(mails);
    if (m) {
        notif += ` · ${m.notif}`;
        spoken += ` ${m.spoken}`;
    }
    const pk = postits.slice(0, 2);
    if (pk.length > 0) {
        notif += ` · post-it : ${pk.join(', ')}`;
        spoken += ` Post-it : ${pk.join(', ')}.`;
    }
    const nt = notes.slice(0, 2);
    if (nt.length > 0) {
        notif += ` · à noter : ${nt.join(', ')}`;
        spoken += ` À noter : ${nt.join(', ')}.`;
    }
    return { notif, spoken };
}

export function returnText(lines: string[]): Rendered {
    return {
        notif: lines.join(' · '),
        spoken: lines.map((l) => (/[.!?]$/.test(l) ? l : `${l}.`)).join(' '),
    };
}

export function mergeTexts(parts: Rendered[]): Rendered {
    return {
        notif: parts.map((p) => p.notif).join('\n'),
        spoken: parts.map((p) => p.spoken).join(' '),
    };
}
