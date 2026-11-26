// Emploi du temps : modèle (semaine type + exceptions datées) et résolution
// pure du mode d'un jour. Priorité : exception > congé > férié > semaine type
// > télétravail par défaut. Les congés viennent de l'agenda (import Outlook).

import type { AgendaEvent } from '../agendaSecretary';
import { holidayName, weekdayOf } from './holidays';

export type DayMode = 'onsite' | 'remote' | 'off';
export interface DayTemplate {
    mode: DayMode;
    leave?: string;
    back?: string;
}
export interface ScheduleException extends DayTemplate {
    date: string;
    note?: string;
}
/** `week` : clés '0' (dimanche) … '6' (samedi). */
export interface Schedule {
    week: Record<string, DayTemplate>;
    exceptions: ScheduleException[];
}
export type PlanReason = 'exception' | 'conge' | 'ferie' | 'semaine' | 'defaut';
export interface DayPlan {
    date: string;
    mode: DayMode;
    leave?: string;
    back?: string;
    reason: PlanReason;
    label?: string;
}

export const DEFAULT_LEAVE = '08:30';
export const DEFAULT_BACK = '18:30';
const MODES: DayMode[] = ['onsite', 'remote', 'off'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 120;

export const DEFAULT_SCHEDULE: Schedule = Object.freeze({
    week: Object.freeze(
        Object.fromEntries(
            ['0', '1', '2', '3', '4', '5', '6'].map((k) => [
                k,
                Object.freeze({ mode: 'remote' as DayMode }),
            ]),
        ),
    ),
    exceptions: Object.freeze([]) as unknown as ScheduleException[],
}) as Schedule;

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Valide un gabarit de jour ; lève une Error au message lisible. */
export function normalizeTemplate(t: unknown): DayTemplate {
    if (!isObj(t)) throw new Error('Jour invalide');
    const mode = t.mode as DayMode;
    if (!MODES.includes(mode))
        throw new Error(`Mode inconnu : ${String(t.mode)}`);
    if (mode !== 'onsite') return { mode };
    const leave =
        t.leave === undefined || t.leave === '' ? DEFAULT_LEAVE : t.leave;
    const back = t.back === undefined || t.back === '' ? DEFAULT_BACK : t.back;
    if (typeof leave !== 'string' || !HHMM.test(leave))
        throw new Error(`Heure de départ invalide : ${String(leave)}`);
    if (typeof back !== 'string' || !HHMM.test(back))
        throw new Error(`Heure de retour invalide : ${String(back)}`);
    if (leave >= back) throw new Error('Le départ doit précéder le retour');
    return { mode, leave, back };
}

export function normalizeException(e: unknown): ScheduleException {
    if (!isObj(e)) throw new Error('Exception invalide');
    const date = e.date;
    if (typeof date !== 'string' || !isRealDate(date))
        throw new Error(`Date invalide : ${String(date)}`);
    const out: ScheduleException = { date, ...normalizeTemplate(e) };
    if (typeof e.note === 'string' && e.note.trim())
        out.note = e.note.trim().slice(0, NOTE_MAX);
    return out;
}

function isRealDate(s: string): boolean {
    if (!YMD.test(s)) return false;
    const d = new Date(`${s}T12:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ── Congés ────────────────────────────────────────────────────────────────────

const LEAVE_WORDS =
    /\b(conge|conges|vacances|absent|absence|rtt|oof|out of office)\b/;
const EXCLUDED_CALENDARS = /famille|f[ée]ri|num[ée]ros de semaine|scolaire/i;
// Vacances scolaires & co : un titre de congé qui ne parle pas de moi.
const NOT_PERSONAL = /\bscolaires?\b/;
const LEAVE_MIN_DURATION = 360;

function dayIndex(date: string): number {
    return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function fold(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** L'événement est-il un congé qui couvre `date` ? */
export function isLeaveEvent(ev: AgendaEvent, date: string): boolean {
    if (ev.calendar && EXCLUDED_CALENDARS.test(ev.calendar)) return false;
    const title = fold(ev.title);
    if (!LEAVE_WORDS.test(title) || NOT_PERSONAL.test(title)) return false;
    if (ev.allDay) return ev.date <= date && date <= (ev.endDate ?? ev.date);
    // Horaire : congé ce jour-là s'il en couvre au moins 6 h (un OOF Outlook
    // lun 09:00 → ven 18:00 couvre aussi les jours du milieu).
    const [h, m] = (ev.start ?? '00:00').split(':').map(Number);
    const start = dayIndex(ev.date) * 1440 + (h || 0) * 60 + (m || 0);
    const end = start + (ev.durationMin ?? 0);
    const dayStart = dayIndex(date) * 1440;
    const covered = Math.min(end, dayStart + 1440) - Math.max(start, dayStart);
    return covered >= LEAVE_MIN_DURATION;
}

// ── Résolution ────────────────────────────────────────────────────────────────

function withTemplate(
    base: { date: string; reason: PlanReason; label?: string },
    t: DayTemplate,
): DayPlan {
    const out: DayPlan = { date: base.date, mode: t.mode, reason: base.reason };
    if (t.mode === 'onsite') {
        out.leave = t.leave ?? DEFAULT_LEAVE;
        out.back = t.back ?? DEFAULT_BACK;
    }
    if (base.label) out.label = base.label;
    return out;
}

export function dayPlan(
    date: string,
    schedule: Schedule,
    events: AgendaEvent[],
): DayPlan {
    const exc = schedule.exceptions.find((e) => e.date === date);
    if (exc) {
        return withTemplate(
            { date, reason: 'exception', label: exc.note },
            exc,
        );
    }
    const leave = events.find((e) => isLeaveEvent(e, date));
    if (leave)
        return { date, mode: 'remote', reason: 'conge', label: leave.title };
    const holiday = holidayName(date);
    if (holiday)
        return { date, mode: 'remote', reason: 'ferie', label: holiday };
    const t = schedule.week[String(weekdayOf(date))];
    if (t) return withTemplate({ date, reason: 'semaine' }, t);
    return { date, mode: 'remote', reason: 'defaut' };
}

// ── Dates ─────────────────────────────────────────────────────────────────────

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** Date `YYYY-MM-DD` en heure LOCALE (jamais l'UTC de toISOString). */
export function localYmd(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Arithmétique de calendrier pure (à midi UTC : pas de piège DST). */
export function addDays(date: string, n: number): string {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
