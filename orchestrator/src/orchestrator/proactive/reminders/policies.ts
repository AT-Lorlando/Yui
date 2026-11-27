import { eventMode, type AgendaEvent } from '../../agendaSecretary';
import { DEFAULT_LEAVE } from '../../schedule/dayPlan';
import { eventsOn, feedOf, isNight, minutesOf } from './feeds';
import {
    departText,
    eveText,
    imminentText,
    morningText,
    parcelText,
    returnText,
} from './templates';
import type { MailSummary } from './templates';
import type { Reminder, ReminderContext } from './types';

// Politiques pures : quels rappels sont dus à l'instant `ctx.now`.
// Un rappel n'est dû que dans sa fenêtre — jamais de rattrapage après coup.

type Done = (key: string) => boolean;

const MIN = 60_000;
const WINDOW_MS = 30 * MIN;
const PARCEL_FRESH_MS = 6 * 60 * MIN;
const RETURN_FRESH_MS = 10 * MIN;
const PARCEL_STATUSES = [
    'out_for_delivery',
    'delivered',
    'pickup_ready',
    'problem',
];

/** Instant local de `date` (YYYY-MM-DD) à `hhmm`. */
function at(date: string, hhmm: string): number {
    const [y, m, d] = date.split('-').map((x) => parseInt(x, 10));
    const mins = minutesOf(hhmm);
    return new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60).getTime();
}

function inWindow(now: number, trigger: number): boolean {
    return now >= trigger && now < trigger + WINDOW_MS;
}

function night(ctx: ReminderContext): boolean {
    return isNight(ctx.now, ctx.quietHours, ctx.wake?.at ?? null);
}

function mailSummary(ctx: ReminderContext): MailSummary {
    return { count: ctx.mailCount, names: ctx.mails };
}

function timedMain(e: AgendaEvent): boolean {
    return feedOf(e) === 'main' && !e.allDay && !!e.start;
}

export function morningDue(ctx: ReminderContext, done: Done): Reminder[] {
    const key = `matin:${ctx.today}`;
    // Agenda illisible : ne pas annoncer une journée vide — la clé reste
    // libre, le point part au tick suivant qui lit l'agenda (fenêtre).
    if (done(key) || !ctx.calendarOk) return [];
    let trigger: number;
    if (ctx.wake) {
        trigger = ctx.wake.at + ctx.wake.afterMin * MIN;
    } else {
        if (ctx.plans.today?.mode === 'off') return [];
        // Repli sans réveil : jamais pendant la nuit (silence qui finit tard).
        if (isNight(ctx.now, ctx.quietHours, null)) return [];
        trigger = at(ctx.today, ctx.settings.morningFallback);
    }
    if (!inWindow(ctx.now.getTime(), trigger)) return [];
    const t = morningText(
        ctx.today,
        eventsOn(ctx.today, ctx.events),
        mailSummary(ctx),
        ctx.postits,
        ctx.notes,
    );
    return [
        {
            key,
            type: 'morning',
            notif: t.notif,
            spoken: t.spoken,
            wantsSpeech: true,
            device: ctx.wake?.device ?? undefined,
        },
    ];
}

export function eveDue(ctx: ReminderContext, done: Done): Reminder[] {
    const key = `agenda:veille:${ctx.tomorrow}`;
    if (done(key) || !ctx.calendarOk) return [];
    if (!inWindow(ctx.now.getTime(), at(ctx.today, ctx.settings.eveTime)))
        return [];
    const parcels = ctx.parcels.filter(
        (p) => p.estimatedDate === ctx.tomorrow && p.status !== 'delivered',
    );
    // Veille : un événement demain OU un colis attendu demain.
    if (eventsOn(ctx.tomorrow, ctx.events).length === 0 && parcels.length === 0)
        return [];
    const t = eveText(ctx.tomorrow, ctx.events, parcels, mailSummary(ctx));
    return [
        {
            key,
            type: 'agenda-eve',
            notif: t.notif,
            spoken: t.spoken,
            wantsSpeech: false,
        },
    ];
}

export function imminentDue(ctx: ReminderContext, done: Done): Reminder[] {
    if (!ctx.calendarOk) return [];
    const now = ctx.now.getTime();
    const out: Reminder[] = [];
    for (const e of eventsOn(ctx.today, ctx.events)) {
        if (!timedMain(e) || e.date !== ctx.today) continue;
        const key = `agenda:${e.id}:pre`;
        if (done(key)) continue;
        const onsite = eventMode(e) === 'onsite';
        if (onsite && ctx.presence !== 'home') continue;
        const lead = onsite
            ? ctx.settings.onsiteLeadMin
            : ctx.settings.visioLeadMin;
        const start = at(ctx.today, e.start as string);
        if (!(start - lead * MIN <= now && now < start)) continue;
        const minutes = Math.max(1, Math.ceil((start - now) / MIN));
        const t = imminentText(e, minutes);
        out.push({
            key,
            type: 'agenda-imminent',
            notif: t.notif,
            spoken: t.spoken,
            wantsSpeech: true,
        });
    }
    return out;
}

export function departDue(ctx: ReminderContext, done: Done): Reminder[] {
    const plan = ctx.plans.today;
    if (!plan || plan.mode !== 'onsite' || ctx.presence !== 'home') return [];
    const key = `depart:${ctx.today}`;
    if (done(key)) return [];
    const leave = plan.leave ?? DEFAULT_LEAVE;
    const trigger = at(ctx.today, leave) - ctx.settings.departLeadMin * MIN;
    if (!inWindow(ctx.now.getTime(), trigger)) return [];
    const timed = eventsOn(ctx.today, ctx.events).filter(
        (e) =>
            timedMain(e) &&
            e.date === ctx.today &&
            (e.start as string) >= leave,
    );
    const first =
        timed.find((e) => eventMode(e) === 'onsite') ?? timed[0] ?? null;
    const t = departText(
        first,
        ctx.weather?.notable ?? null,
        ctx.settings.departLeadMin,
    );
    return [
        {
            key,
            type: 'depart',
            notif: t.notif,
            spoken: t.spoken,
            wantsSpeech: true,
        },
    ];
}

export function parcelDue(ctx: ReminderContext, done: Done): Reminder[] {
    const now = ctx.now.getTime();
    const out: Reminder[] = [];
    for (const p of ctx.parcels) {
        if (!PARCEL_STATUSES.includes(p.status)) continue;
        if (now - p.updatedAt > PARCEL_FRESH_MS) continue;
        const key = `parcel:${p.id}:${p.status}`;
        if (done(key)) continue;
        const t = parcelText(p);
        out.push({
            key,
            type: 'parcel',
            notif: t.notif,
            spoken: t.spoken,
            wantsSpeech: p.status === 'delivered',
        });
    }
    return out;
}

export function returnDue(ctx: ReminderContext, done: Done): Reminder[] {
    if (ctx.plans.today?.mode !== 'onsite') return [];
    const { returnedAt, lastDepartureAt } = ctx;
    if (returnedAt == null || lastDepartureAt == null) return [];
    const now = ctx.now.getTime();
    if (now < returnedAt || now - returnedAt > RETURN_FRESH_MS) return [];
    const key = `retour:${ctx.today}`;
    if (done(key)) return [];
    const lines = ctx.parcels
        .filter(
            (p) =>
                p.status === 'delivered' &&
                p.updatedAt >= lastDepartureAt &&
                p.updatedAt <= returnedAt,
        )
        .map((p) => `Colis « ${p.label} » livré pendant ton absence`);
    if (lines.length === 0) return [];
    const t = returnText(lines);
    return [
        {
            key,
            type: 'return',
            notif: t.notif,
            spoken: t.spoken,
            wantsSpeech: true,
        },
    ];
}

export function dueReminders(ctx: ReminderContext, done: Done): Reminder[] {
    const out = morningDue(ctx, done);
    if (night(ctx)) return out;
    return [
        ...out,
        ...eveDue(ctx, done),
        ...imminentDue(ctx, done),
        ...departDue(ctx, done),
        ...parcelDue(ctx, done),
        ...returnDue(ctx, done),
    ];
}
