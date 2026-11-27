import type { AgendaEvent } from '../../agendaSecretary';
import { localYmd } from '../../schedule/dayPlan';
import { isQuietHours } from '../gates';

export type Feed = 'main' | 'family' | 'excluded';

const EXCLUDED_RE = /f[ée]ri|num[ée]ros de semaine/i;
const FAMILY_RE = /famille/i;

export function feedOf(e: AgendaEvent): Feed {
    const cal = e.calendar ?? '';
    if (EXCLUDED_RE.test(cal)) return 'excluded';
    if (FAMILY_RE.test(cal)) return 'family';
    return 'main';
}

/** Événements couvrant `date` (multi-jours inclus), hors agendas exclus ;
 *  journée entière d'abord, puis par heure de début. */
export function eventsOn(date: string, events: AgendaEvent[]): AgendaEvent[] {
    return events
        .filter(
            (e) =>
                feedOf(e) !== 'excluded' &&
                e.date <= date &&
                (e.endDate ?? e.date) >= date &&
                (e.allDay || e.date === date),
        )
        .sort((a, b) => {
            if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
            return (a.start ?? '').localeCompare(b.start ?? '');
        });
}

export function minutesOf(hhmm: string): number {
    const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
    return (h || 0) * 60 + (m || 0);
}

/** Nuit = heures de silence, sauf si le réveil du jour est passé. */
export function isNight(
    now: Date,
    quiet: { start: string; end: string },
    wakeAt: number | null,
): boolean {
    if (!isQuietHours(now, quiet)) return false;
    if (
        wakeAt == null ||
        localYmd(new Date(wakeAt)) !== localYmd(now) ||
        now.getTime() < wakeAt
    )
        return true;
    // Le réveil ne lève que la partie matinale de la fenêtre de silence.
    const start = minutesOf(quiet.start);
    const end = minutesOf(quiet.end);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (start > end) return nowMin >= end;
    const w = new Date(wakeAt);
    const wakeMin = w.getHours() * 60 + w.getMinutes();
    return !(wakeMin >= start && wakeMin < end);
}
