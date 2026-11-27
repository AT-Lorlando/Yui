import type { calendar_v3 } from 'googleapis';

const TIMEZONE = 'Europe/Paris';

export interface TaggedEvent {
    id: string;
    calendarId: string;
    title: string;
    date: string;
    allDay: boolean;
    start: string | null;
    durationMin: number | null;
    yuiRule: string;
    yuiDate: string;
    /** Instance de Yui qui l'a posé (dev/prod sur le même compte) ; null si absent. */
    yuiInstance: string | null;
}

function parisDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function parisTime(iso: string): string {
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(iso));
}

/** Compact view of an event carrying a `yuiRule` private property; null otherwise. */
export function taggedView(
    ev: calendar_v3.Schema$Event,
    calendarId: string,
): TaggedEvent | null {
    const priv = ev.extendedProperties?.private;
    const yuiRule = priv?.yuiRule;
    if (!yuiRule || ev.status === 'cancelled' || !ev.id) return null;

    const base = {
        id: ev.id,
        calendarId,
        title: ev.summary ?? '(Sans titre)',
        yuiRule,
    };
    const yuiInstance = priv?.yuiInstance || null;

    if (ev.start?.date) {
        return {
            ...base,
            date: ev.start.date,
            allDay: true,
            start: null,
            durationMin: null,
            yuiDate: priv?.yuiDate ?? ev.start.date,
            yuiInstance,
        };
    }
    if (ev.start?.dateTime) {
        const s = ev.start.dateTime;
        const e = ev.end?.dateTime;
        const date = parisDate(s);
        return {
            ...base,
            date,
            allDay: false,
            start: parisTime(s),
            durationMin: e
                ? Math.round(
                      (new Date(e).getTime() - new Date(s).getTime()) / 60000,
                  )
                : null,
            yuiDate: priv?.yuiDate ?? date,
            yuiInstance,
        };
    }
    return null;
}

export interface CalendarEntry {
    id?: string | null;
    primary?: boolean | null;
    accessRole?: string | null;
}

/**
 * Writable calendars to scan for tagged events. The primary calendar (listed by
 * Google under its real id, the account email) is reported as 'primary', the
 * alias rules use by default; `primaryId` gives the real id.
 */
export function taggedCalendars(items: CalendarEntry[]): {
    primaryId: string | null;
    calendars: Array<{ fetchId: string; reportId: string }>;
} {
    let primaryId: string | null = null;
    const calendars: Array<{ fetchId: string; reportId: string }> = [];
    for (const c of items) {
        if (!c.id || (c.accessRole !== 'owner' && c.accessRole !== 'writer'))
            continue;
        if (c.primary) primaryId = c.id;
        calendars.push({
            fetchId: c.id,
            reportId: c.primary ? 'primary' : c.id,
        });
    }
    return { primaryId, calendars };
}
