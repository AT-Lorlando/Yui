import { google } from 'googleapis';
import type { Auth, calendar_v3 } from 'googleapis';
import Logger from './logger';

const TIMEZONE = 'Europe/Paris';

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatDate(isoOrDate: string): string {
    const date = new Date(isoOrDate);
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: TIMEZONE,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    }).format(date);
}

function formatTime(isoOrDate: string): string {
    const date = new Date(isoOrDate);
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(date);
}

function formatDuration(startIso: string, endIso: string): string {
    const diffMin = Math.round(
        (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000,
    );
    if (diffMin < 60) return `${diffMin} min`;
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

function relativeTime(isoOrDate: string): string {
    const diffMin = Math.round(
        (new Date(isoOrDate).getTime() - Date.now()) / 60000,
    );
    const abs = Math.abs(diffMin);
    const future = diffMin > 0;

    if (abs < 2) return 'maintenant';
    if (future) {
        if (abs < 60) return `dans ${abs} min`;
        if (abs < 1440) return `dans ${Math.round(abs / 60)}h`;
        if (abs < 2880) return 'demain';
        if (abs < 10080) return `dans ${Math.round(abs / 1440)} jours`;
    } else {
        if (abs < 60) return `il y a ${abs} min`;
        if (abs < 1440) return `il y a ${Math.round(abs / 60)}h`;
        if (abs < 2880) return 'hier';
        if (abs < 10080) return `il y a ${Math.round(abs / 1440)} jours`;
    }
    return '';
}

const RESPONSE_LABEL: Record<string, string> = {
    accepted: '[OK]',
    declined: '[Refusé]',
    tentative: '[Peut-être]',
    needsAction: '[En attente]',
};

function formatEvent(
    event: calendar_v3.Schema$Event,
    calendarName?: string,
): object {
    const base: Record<string, unknown> = {
        id:       event.id,
        title:    event.summary ?? '(Sans titre)',
        status:   event.status ?? 'confirmed',
        calendar: calendarName ?? null,
    };

    if (event.status === 'cancelled') return { ...base, cancelled: true };

    // Time
    if (event.start?.date) {
        base.all_day   = true;
        base.date      = event.start.date;
        const endDateRaw = event.end?.date;
        if (endDateRaw && endDateRaw !== event.start.date) {
            const endExclusive = new Date(endDateRaw);
            endExclusive.setDate(endExclusive.getDate() - 1);
            const endStr = endExclusive.toISOString().split('T')[0];
            if (endStr !== event.start.date) base.end_date = endStr;
        }
    } else if (event.start?.dateTime) {
        const start = event.start.dateTime;
        const end   = event.end?.dateTime;
        base.all_day  = false;
        base.date     = start.slice(0, 10);
        base.start    = formatTime(start);
        base.end      = end ? formatTime(end) : null;
        base.duration_min = end ? Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000) : null;
        base.relative = relativeTime(start) || null;
    }

    if (event.location)   base.location = event.location;

    // Attendees
    if (event.attendees && event.attendees.length > 0) {
        const self   = event.attendees.find((a) => a.self);
        const others = event.attendees.filter((a) => !a.self);
        if (self) base.my_response = self.responseStatus ?? 'needsAction';
        if (others.length > 0) {
            base.attendees = others.slice(0, 8).map((a) => ({
                name:     a.displayName ?? a.email,
                response: a.responseStatus ?? 'needsAction',
            }));
        }
    }

    // Google Meet
    const meetLink = event.hangoutLink ?? event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
    if (meetLink) base.meet_link = meetLink;

    // Description
    if (event.description) {
        const plain = event.description.replace(/<[^>]*>/g, '').replace(/\n+/g, ' ').trim();
        if (plain) base.note = plain.length > 200 ? plain.slice(0, 197) + '...' : plain;
    }

    base.recurring = Boolean(event.recurrence?.length || event.recurringEventId);

    return base;
}

// ── Date utilities ────────────────────────────────────────────────────────────

/** Today as YYYY-MM-DD in Europe/Paris. */
function todayParis(): string {
    return new Date().toLocaleDateString('fr-CA', { timeZone: TIMEZONE });
}

/** Start of current ISO week (Monday) as YYYY-MM-DD in Europe/Paris. */
function weekStartParis(): string {
    const localStr = new Date().toLocaleDateString('en-CA', {
        timeZone: TIMEZONE,
    });
    const d = new Date(`${localStr}T00:00:00`);
    const dow = d.getDay(); // 0=Sun
    const diff = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + diff);
    return d.toISOString().split('T')[0];
}

/** End of current ISO week (Sunday) as YYYY-MM-DD. */
function weekEndParis(): string {
    const monday = weekStartParis();
    const d = new Date(`${monday}T00:00:00`);
    d.setDate(d.getDate() + 6);
    return d.toISOString().split('T')[0];
}

/**
 * Convert a YYYY-MM-DD string to a UTC ISO timestamp representing
 * the given time-of-day in Europe/Paris.
 */
function parisToUtcIso(dateStr: string, timeStr: string): string {
    // Build a Date using the local JS engine. Works correctly when the server
    // runs in Europe/Paris (as it does in production). The timezone offset is
    // embedded in the resulting ISO string.
    return new Date(`${dateStr}T${timeStr}`).toISOString();
}

// ── Internal type ─────────────────────────────────────────────────────────────

interface EventWithCalendar extends calendar_v3.Schema$Event {
    _calendarName: string;
}

// ── CalendarClient ────────────────────────────────────────────────────────────

export class CalendarClient {
    private cal: calendar_v3.Calendar;

    constructor(auth: Auth.OAuth2Client) {
        this.cal = google.calendar({ version: 'v3', auth });
    }

    // ── Calendar list ──────────────────────────────────────────────────────────

    async listCalendars(): Promise<object> {
        const res = await this.cal.calendarList.list({ showHidden: false });
        const cals = (res.data.items ?? []).map((c) => ({
            id:          c.id,
            name:        c.summary,
            primary:     c.primary ?? false,
            access_role: c.accessRole,
            description: c.description ?? null,
        }));
        return { calendars: cals };
    }

    // ── Schedule ───────────────────────────────────────────────────────────────

    /**
     * Get events for a date range across all (or specific) calendars.
     * Results are grouped by day and formatted for the LLM.
     */
    async getSchedule(options: {
        startDate?: string; // YYYY-MM-DD, defaults to today
        endDate?: string; // YYYY-MM-DD, defaults to startDate
        calendarIds?: string[];
        maxResults?: number;
    }): Promise<object> {
        const start = options.startDate ?? todayParis();
        const end = options.endDate ?? start;
        const timeMin = parisToUtcIso(start, '00:00:00');
        const timeMax = parisToUtcIso(end, '23:59:59');

        // Always load calendar metadata so we know access roles (freeBusyReader
        // calendars hide event titles — we substitute "Professional meeting").
        const calNames = new Map<string, string>();
        const professionalCalIds = new Set<string>();
        const listRes = await this.cal.calendarList.list({ showHidden: false });
        for (const c of listRes.data.items ?? []) {
            if (!c.id) continue;
            calNames.set(c.id, c.summary ?? c.id);
            if (c.accessRole === 'freeBusyReader') {
                professionalCalIds.add(c.id);
            }
        }

        // Use provided IDs or fall back to all calendars
        const calIds =
            options.calendarIds && options.calendarIds.length > 0
                ? options.calendarIds
                : Array.from(calNames.keys());

        // Fetch events from all calendars in parallel
        const allEvents: EventWithCalendar[] = [];

        await Promise.all(
            calIds.map(async (calId) => {
                try {
                    const res = await this.cal.events.list({
                        calendarId: calId,
                        timeMin,
                        timeMax,
                        singleEvents: true,
                        orderBy: 'startTime',
                        maxResults: options.maxResults ?? 50,
                        timeZone: TIMEZONE,
                    });
                    const name = calNames.get(calId) ?? calId;
                    const isProfessional = professionalCalIds.has(calId);
                    for (const ev of res.data.items ?? []) {
                        allEvents.push({
                            ...ev,
                            // freeBusyReader hides titles — substitute a meaningful label
                            summary:
                                ev.summary ??
                                (isProfessional
                                    ? 'Professional meeting'
                                    : undefined),
                            _calendarName: name,
                        });
                    }
                } catch (err) {
                    Logger.warn(
                        `Failed to fetch events for calendar "${calId}": ${err}`,
                    );
                }
            }),
        );

        // Sort chronologically
        allEvents.sort((a, b) => {
            const aKey = a.start?.dateTime ?? a.start?.date ?? '';
            const bKey = b.start?.dateTime ?? b.start?.date ?? '';
            return aKey.localeCompare(bKey);
        });

        if (allEvents.length === 0) {
            return { events: [], start, end };
        }

        // Group by day
        const grouped = new Map<string, object[]>();
        for (const ev of allEvents) {
            const day = ev.start?.date ?? ev.start?.dateTime?.slice(0, 10) ?? 'unknown';
            if (!grouped.has(day)) grouped.set(day, []);
            grouped.get(day)!.push(formatEvent(ev, ev._calendarName));
        }

        const days = Array.from(grouped.entries()).map(([date, events]) => ({ date, events }));
        return { start, end, days };
    }

    async getToday(): Promise<object> {
        return this.getSchedule({});
    }

    async getWeek(): Promise<object> {
        return this.getSchedule({
            startDate: weekStartParis(),
            endDate: weekEndParis(),
        });
    }

    // ── Single event ───────────────────────────────────────────────────────────

    async getEvent(calendarId: string, eventId: string): Promise<object> {
        const res = await this.cal.events.get({ calendarId, eventId });
        return formatEvent(res.data);
    }

    // ── Create event ───────────────────────────────────────────────────────────

    async createEvent(options: {
        calendarId?: string;
        title: string;
        startDateTime?: string;
        endDateTime?: string;
        startDate?: string;
        endDate?: string;
        location?: string;
        description?: string;
        attendeeEmails?: string[];
        recurrence?: string;
    }): Promise<object> {
        const calId = options.calendarId ?? 'primary';

        const body: calendar_v3.Schema$Event = {
            summary: options.title,
            location: options.location,
            description: options.description,
        };

        if (options.startDate) {
            body.start = { date: options.startDate };
            body.end = { date: options.endDate ?? options.startDate };
        } else if (options.startDateTime) {
            body.start = {
                dateTime: options.startDateTime,
                timeZone: TIMEZONE,
            };
            body.end = {
                dateTime: options.endDateTime ?? options.startDateTime,
                timeZone: TIMEZONE,
            };
        }

        if (options.attendeeEmails?.length) {
            body.attendees = options.attendeeEmails.map((email) => ({ email }));
        }

        if (options.recurrence) {
            body.recurrence = [options.recurrence];
        }

        const res = await this.cal.events.insert({
            calendarId: calId,
            requestBody: body,
            sendUpdates: options.attendeeEmails?.length ? 'all' : 'none',
        });

        return { ok: true, id: res.data.id, title: res.data.summary, link: res.data.htmlLink };
    }

    // ── Update event ───────────────────────────────────────────────────────────

    async updateEvent(options: {
        calendarId?: string;
        eventId: string;
        title?: string;
        startDateTime?: string;
        endDateTime?: string;
        startDate?: string;
        endDate?: string;
        location?: string;
        description?: string;
        attendeeEmails?: string[];
    }): Promise<object> {
        const calId = options.calendarId ?? 'primary';

        // Fetch current state so we only change what was provided
        const current = (
            await this.cal.events.get({
                calendarId: calId,
                eventId: options.eventId,
            })
        ).data;

        const body: calendar_v3.Schema$Event = { ...current };

        if (options.title !== undefined) body.summary = options.title;
        if (options.location !== undefined) body.location = options.location;
        if (options.description !== undefined)
            body.description = options.description;

        if (options.startDate) {
            body.start = { date: options.startDate };
            body.end = { date: options.endDate ?? options.startDate };
        } else if (options.startDateTime) {
            body.start = {
                dateTime: options.startDateTime,
                timeZone: TIMEZONE,
            };
            body.end = {
                dateTime: options.endDateTime ?? options.startDateTime,
                timeZone: TIMEZONE,
            };
        }

        if (options.attendeeEmails !== undefined) {
            body.attendees = options.attendeeEmails.map((email) => ({ email }));
        }

        const res = await this.cal.events.update({
            calendarId: calId,
            eventId: options.eventId,
            requestBody: body,
        });

        return { ok: true, id: res.data.id, title: res.data.summary, link: res.data.htmlLink };
    }

    // ── Delete event ───────────────────────────────────────────────────────────

    async deleteEvent(calendarId: string, eventId: string): Promise<object> {
        let title = eventId;
        try {
            const ev = await this.cal.events.get({ calendarId, eventId });
            title = ev.data.summary ?? eventId;
        } catch { /* ignore */ }

        await this.cal.events.delete({ calendarId, eventId, sendUpdates: 'all' });
        return { ok: true, deleted: title };
    }

    // ── Search ─────────────────────────────────────────────────────────────────

    /**
     * Full-text search across one calendar (or all if calendarId is omitted).
     * Google searches title, description, location, and attendee names/emails.
     */
    async searchEvents(options: {
        query: string;
        calendarId?: string;
        maxResults?: number;
    }): Promise<object> {
        const calIds: string[] = [];
        const calNames = new Map<string, string>();

        if (options.calendarId) {
            calIds.push(options.calendarId);
        } else {
            const listRes = await this.cal.calendarList.list({
                showHidden: false,
            });
            for (const c of listRes.data.items ?? []) {
                if (c.id) {
                    calIds.push(c.id);
                    calNames.set(c.id, c.summary ?? c.id);
                }
            }
        }

        const allEvents: EventWithCalendar[] = [];

        await Promise.all(
            calIds.map(async (calId) => {
                try {
                    const res = await this.cal.events.list({
                        calendarId: calId,
                        q: options.query,
                        singleEvents: true,
                        orderBy: 'startTime',
                        maxResults: options.maxResults ?? 20,
                        timeMin: new Date().toISOString(), // future events first
                        timeZone: TIMEZONE,
                    });
                    const name = calNames.get(calId) ?? calId;
                    for (const ev of res.data.items ?? []) {
                        allEvents.push({ ...ev, _calendarName: name });
                    }
                } catch (err) {
                    Logger.warn(
                        `Search failed for calendar "${calId}": ${err}`,
                    );
                }
            }),
        );

        allEvents.sort((a, b) => {
            const aKey = a.start?.dateTime ?? a.start?.date ?? '';
            const bKey = b.start?.dateTime ?? b.start?.date ?? '';
            return aKey.localeCompare(bKey);
        });

        const events = allEvents.map((ev) => formatEvent(ev, ev._calendarName));
        return { query: options.query, count: events.length, events };
    }

    // ── Free / busy ────────────────────────────────────────────────────────────

    /**
     * Find available time slots on a given day using the freebusy API.
     * Only considers events that have a start and end dateTime (not all-day).
     */
    async findFreeSlots(options: {
        date: string; // YYYY-MM-DD
        durationMinutes: number;
        calendarIds?: string[];
        workdayStart?: number; // hour 0-23, default 9
        workdayEnd?: number; // hour 0-23, default 19
    }): Promise<object> {
        const { date, durationMinutes } = options;
        const wStart = options.workdayStart ?? 9;
        const wEnd = options.workdayEnd ?? 19;

        let calIds = options.calendarIds ?? [];
        if (calIds.length === 0) {
            const listRes = await this.cal.calendarList.list({
                showHidden: false,
            });
            calIds = (listRes.data.items ?? [])
                .map((c) => c.id!)
                .filter(Boolean);
        }

        const timeMin = parisToUtcIso(
            date,
            `${String(wStart).padStart(2, '0')}:00:00`,
        );
        const timeMax = parisToUtcIso(
            date,
            `${String(wEnd).padStart(2, '0')}:00:00`,
        );

        const res = await this.cal.freebusy.query({
            requestBody: {
                timeMin,
                timeMax,
                timeZone: TIMEZONE,
                items: calIds.map((id) => ({ id })),
            },
        });

        // Collect and merge all busy intervals
        const busy: Array<{ start: Date; end: Date }> = [];
        const calendars = res.data.calendars ?? {};
        for (const calId of calIds) {
            for (const slot of calendars[calId]?.busy ?? []) {
                if (slot.start && slot.end) {
                    busy.push({
                        start: new Date(slot.start),
                        end: new Date(slot.end),
                    });
                }
            }
        }

        // Sort and merge overlapping intervals
        busy.sort((a, b) => a.start.getTime() - b.start.getTime());
        const merged: Array<{ start: Date; end: Date }> = [];
        for (const interval of busy) {
            const last = merged[merged.length - 1];
            if (last && interval.start <= last.end) {
                last.end = interval.end > last.end ? interval.end : last.end;
            } else {
                merged.push({ ...interval });
            }
        }

        // Walk through the workday and collect gaps >= durationMinutes
        const dayStart = new Date(timeMin);
        const dayEnd = new Date(timeMax);
        const free: Array<{ start: Date; end: Date }> = [];
        let cursor = dayStart;

        for (const b of merged) {
            if (b.start > cursor) {
                const gap = (b.start.getTime() - cursor.getTime()) / 60000;
                if (gap >= durationMinutes)
                    free.push({ start: cursor, end: b.start });
            }
            if (b.end > cursor) cursor = b.end;
        }
        if (cursor < dayEnd) {
            const gap = (dayEnd.getTime() - cursor.getTime()) / 60000;
            if (gap >= durationMinutes)
                free.push({ start: cursor, end: dayEnd });
        }

        const slots = free.map((slot) => ({
            start:        formatTime(slot.start.toISOString()),
            end:          formatTime(slot.end.toISOString()),
            duration_min: Math.round((slot.end.getTime() - slot.start.getTime()) / 60000),
        }));
        return { date, duration_min: durationMinutes, free_slots: slots };
    }

    // ── Quick add ──────────────────────────────────────────────────────────────

    async quickAdd(text: string, calendarId = 'primary'): Promise<object> {
        const res = await this.cal.events.quickAdd({ calendarId, text });
        return { ok: true, id: res.data.id, title: res.data.summary, link: res.data.htmlLink };
    }
}
