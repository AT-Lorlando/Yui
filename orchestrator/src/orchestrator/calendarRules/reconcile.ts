// Réconciliation pure : occurrences voulues des règles ↔ événements Google déjà
// étiquetés `yuiRule`. Ne touche jamais un événement passé (jour antérieur,
// journée entière du jour, ou minuté du jour déjà commencé), ni un événement
// au-delà de l'horizon.

import { addDays, localYmd } from '../schedule/dayPlan';
import { CalendarRule } from './model';
import { occurrences } from './occurrences';

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
    /** Instance de Yui qui l'a posé (null : ancien, ou posé ailleurs). */
    yuiInstance?: string | null;
}

export interface DesiredEvent {
    ruleId: string;
    date: string;
    calendarId: string;
    title: string;
    allDay: boolean;
    time?: string;
    durationMin?: number;
    description?: string;
}

export interface ReconcilePlan {
    create: DesiredEvent[];
    update: Array<{ event: TaggedEvent; want: DesiredEvent }>;
    remove: TaggedEvent[];
}

export const HORIZON_DAYS = 92;

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (rule: string, date: string) => `${rule}@${date}`;

function desiredFor(rules: CalendarRule[], from: string, to: string) {
    const out = new Map<string, DesiredEvent>();
    for (const r of rules) {
        if (!r.enabled) continue;
        for (const date of occurrences(r, from, to)) {
            const d: DesiredEvent = {
                ruleId: r.id,
                date,
                calendarId: r.calendarId,
                title: r.title,
                allDay: r.allDay,
            };
            if (!r.allDay) {
                d.time = r.time;
                d.durationMin = r.durationMin;
            }
            if (r.description) d.description = r.description;
            out.set(keyOf(r.id, date), d);
        }
    }
    return out;
}

/** Même agenda, titre, type et horaire : rien à faire. */
function matches(e: TaggedEvent, w: DesiredEvent): boolean {
    if (e.calendarId !== w.calendarId || e.title !== w.title) return false;
    if (e.allDay !== w.allDay) return false;
    if (w.allDay) return true;
    return e.start === w.time && e.durationMin === w.durationMin;
}

export function planReconcile(
    rules: CalendarRule[],
    existing: TaggedEvent[],
    now: Date,
    horizonDays: number = HORIZON_DAYS,
): ReconcilePlan {
    const today = localYmd(now);
    const nowHm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const end = addDays(today, horizonDays);
    const desired = desiredFor(rules, today, end);

    const startedOn = (day: string, e: TaggedEvent) =>
        day < today ||
        (day === today && (e.allDay || e.start === null || e.start <= nowHm));
    const locked = (e: TaggedEvent) =>
        startedOn(e.yuiDate, e) || startedOn(e.date, e);

    const plan: ReconcilePlan = { create: [], update: [], remove: [] };
    const byKey = new Map<string, TaggedEvent[]>();
    for (const e of existing) {
        // Au-delà de l'horizon : laissé tel quel.
        if (e.yuiDate > end) continue;
        const k = keyOf(e.yuiRule, e.yuiDate);
        const list = byKey.get(k);
        if (list) list.push(e);
        else byKey.set(k, [e]);
    }

    for (const [k, events] of byKey) {
        const want = desired.get(k);
        const open = events.filter((e) => !locked(e));
        if (!want) {
            plan.remove.push(...open);
            continue;
        }
        // Un événement verrouillé couvre déjà l'occurrence : doublons ouverts retirés.
        if (open.length < events.length) {
            plan.remove.push(...open);
            continue;
        }
        const keep = open.find((e) => matches(e, want)) ?? open[0];
        plan.remove.push(...open.filter((e) => e !== keep));
        if (keep.calendarId !== want.calendarId) {
            plan.remove.push(keep);
            plan.create.push(want);
        } else if (!matches(keep, want)) {
            plan.update.push({ event: keep, want });
        }
    }

    for (const [k, want] of desired) {
        if (byKey.has(k)) continue;
        // Minuté d'aujourd'hui déjà commencé : trop tard pour le poser.
        if (!want.allDay && want.date === today && (want.time ?? '') <= nowHm)
            continue;
        plan.create.push(want);
    }
    return plan;
}
