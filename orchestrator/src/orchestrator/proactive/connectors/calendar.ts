// Agenda : rappels avant les événements du jour (chemin historique), et
// deux lectures « secrétaire » de l'agenda à 60 jours : les CHANGEMENTS
// (ajout, déplacement, disparition d'un événement lointain, par comparaison
// avec l'instantané du poll précédent) et, le soir, « demain tôt ». Une seule
// lecture du calendrier par tick, partagée avec le journal de situation.
import { createHash } from 'crypto';
import { evaluateCalendar } from '../watchers/calendar';
import { fetchAgendaEventsCached } from '../../agendaSecretary';
import type { AgendaEvent } from '../../agendaSecretary';
import { fromCandidate, SUBJECT_MAX } from '../events';
import type { Event, Fact } from '../events';
import type { ConnectorDef } from '../connector';

export interface AgendaSnapshotEntry {
    title: string;
    date: string;
    start: string | null;
    endDate: string | null;
    location: string | null;
    /** Occurrences du même titre dans l'instantané — ≥ 2 = récurrent. */
    seenTitleCount: number;
}

export type AgendaSnapshot = Record<string, AgendaSnapshotEntry>;

type ChangeNature = 'new' | 'moved' | 'cancelled';

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** Un changement à moins de 24 h relève des rappels, pas de la secrétaire. */
const FAR_MS = DAY_MS;
const RECURRING_MIN = 2;
/** Débuts de journée gardés pour la médiane (jours ouvrés). */
const START_HISTORY_MAX = 30;
/** « Demain tôt » = avant 9 h, ou avant l'heure habituelle si elle est plus tardive. */
const EARLY_DEFAULT_MIN = 9 * 60;
/** Fenêtre du soir où « demain tôt » est annoncé (chevauche minuit). */
const EVENING_FROM_H = 20;
const EVENING_TO_H = 3;
const SNAPSHOT_MAX = 10;

const FR_DAYS = [
    'dimanche',
    'lundi',
    'mardi',
    'mercredi',
    'jeudi',
    'vendredi',
    'samedi',
];
const FR_MONTHS = [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre',
];

/** Début d'un événement en heure locale (minuit pour une journée entière). */
function startMs(ev: { date: string; start: string | null }): number {
    return new Date(`${ev.date}T${ev.start ?? '00:00'}:00`).getTime();
}

/** YYYY-MM-DD local. */
function localYmd(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        '0',
    )}-${String(d.getDate()).padStart(2, '0')}`;
}

/** « lundi 5 octobre » — l'année seulement si elle n'est pas celle du moment. */
function frDate(ymd: string, now: number): string {
    const d = new Date(`${ymd}T00:00:00`);
    if (Number.isNaN(d.getTime())) return ymd;
    const year =
        d.getFullYear() !== new Date(now).getFullYear()
            ? ` ${d.getFullYear()}`
            : '';
    return `${FR_DAYS[d.getDay()]} ${d.getDate()} ${
        FR_MONTHS[d.getMonth()]
    }${year}`;
}

function titleKey(title: string): string {
    return title.trim().toLowerCase();
}

function fingerprint(e: {
    date: string;
    start: string | null;
    endDate: string | null;
    location: string | null;
}): string {
    return createHash('sha1')
        .update(
            `${e.date}|${e.start ?? ''}|${e.endDate ?? ''}|${e.location ?? ''}`,
        )
        .digest('hex')
        .slice(0, 8);
}

function toSnapshot(events: AgendaEvent[]): AgendaSnapshot {
    const counts = new Map<string, number>();
    for (const ev of events) {
        const k = titleKey(ev.title);
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const out: AgendaSnapshot = {};
    for (const ev of events) {
        out[ev.id] = {
            title: ev.title,
            date: ev.date,
            start: ev.start,
            endDate: ev.endDate,
            location: ev.location,
            seenTitleCount: counts.get(titleKey(ev.title)) ?? 1,
        };
    }
    return out;
}

function changeEvent(
    id: string,
    nature: ChangeNature,
    entry: Omit<AgendaSnapshotEntry, 'seenTitleCount'>,
    now: number,
): Event {
    const when = `${frDate(entry.date, now)}${
        entry.start ? ` à ${entry.start}` : ''
    }`;
    const subject =
        nature === 'new'
            ? `Tu as ajouté “${entry.title}” le ${when}`
            : nature === 'moved'
            ? `“${entry.title}” passe au ${when}${
                  entry.location ? `, ${entry.location}` : ''
              }`
            : `“${entry.title}” du ${frDate(
                  entry.date,
                  now,
              )} a disparu de l'agenda`;
    return {
        source: 'calendar',
        key: `agenda-${id}-${nature}-${fingerprint(entry)}`,
        kind: 'info',
        importance: 'utile',
        subject: subject.replace(/\s+/g, ' ').slice(0, SUBJECT_MAX),
        // Marqueur de nature lu par la collecte des faits du brief : un
        // changement lointain se dit une fois pour toutes.
        facts: ['nature:agenda-far'],
        at: now,
        // Périmé une fois l'événement passé (ou, s'il est déjà proche, dans 1 h).
        ttlMs: Math.max(startMs(entry) - now, HOUR_MS),
    };
}

/**
 * Compare l'agenda lu à l'instantané du poll précédent. Pur.
 *
 * - Instantané vide (premier poll) : on mémorise sans rien émettre.
 * - Lecture vide alors qu'on connaissait des événements : lecture douteuse
 *   (calendrier injoignable, réponse mal formée) — rien n'est conclu et
 *   l'instantané est conservé, sinon tout l'agenda passerait pour annulé.
 * - Seuls les événements à plus de 24 h comptent, pour les trois natures.
 * - « Nouveau » exclut les titres déjà vus ≥ 2 fois (réunions récurrentes).
 */
export function diffAgenda(
    prev: AgendaSnapshot,
    next: AgendaEvent[],
    now: number,
): { events: Event[]; snapshot: AgendaSnapshot } {
    const snapshot = toSnapshot(next);
    const prevIds = Object.keys(prev);
    if (prevIds.length === 0) return { events: [], snapshot };
    if (next.length === 0) return { events: [], snapshot: prev };

    const isFar = (e: { date: string; start: string | null }) =>
        startMs(e) - now >= FAR_MS;
    const prevTitleCount = new Map<string, number>();
    for (const e of Object.values(prev)) {
        const k = titleKey(e.title);
        prevTitleCount.set(
            k,
            Math.max(prevTitleCount.get(k) ?? 0, e.seenTitleCount ?? 0),
        );
    }

    const events: Event[] = [];
    for (const ev of next) {
        if (!isFar(ev)) continue;
        const entry = snapshot[ev.id]!;
        const old = prev[ev.id];
        if (!old) {
            const seen = prevTitleCount.get(titleKey(ev.title)) ?? 0;
            if (seen >= RECURRING_MIN) continue;
            events.push(changeEvent(ev.id, 'new', entry, now));
        } else if (fingerprint(old) !== fingerprint(entry)) {
            events.push(changeEvent(ev.id, 'moved', entry, now));
        }
    }
    for (const id of prevIds) {
        if (snapshot[id]) continue;
        const old = prev[id]!;
        if (!isFar(old)) continue;
        events.push(changeEvent(id, 'cancelled', old, now));
    }
    return { events, snapshot };
}

function minutesOf(hhmm: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

/** Médiane des débuts (minutes depuis minuit) ; null sans historique lisible. */
function medianStart(history: string[]): number | null {
    const mins = history
        .map(minutesOf)
        .filter((m): m is number => m !== null)
        .sort((a, b) => a - b);
    if (mins.length === 0) return null;
    const mid = Math.floor(mins.length / 2);
    return mins.length % 2 === 1
        ? mins[mid]!
        : (mins[mid - 1]! + mins[mid]!) / 2;
}

/** Le matin qui vient : demain, ou aujourd'hui si on est déjà après minuit. */
function nextMorningYmd(now: number): string {
    const d = new Date(now);
    if (d.getHours() >= EVENING_TO_H) d.setDate(d.getDate() + 1);
    return localYmd(d.getTime());
}

/** Premier événement horaire de demain de la journée. */
function firstTimedOf(events: AgendaEvent[], ymd: string): AgendaEvent | null {
    let first: AgendaEvent | null = null;
    for (const ev of events) {
        if (ev.date !== ymd || !ev.start || minutesOf(ev.start) === null)
            continue;
        if (!first || minutesOf(ev.start)! < minutesOf(first.start!)!) {
            first = ev;
        }
    }
    return first;
}

/**
 * Premier événement de demain s'il commence tôt : avant 9 h, ou avant la
 * médiane des débuts des derniers jours ouvrés quand elle est plus tardive
 * (le seuil est le plus grand des deux — « plus tôt que d'habitude »). Pur.
 */
export function earlyTomorrow(
    events: AgendaEvent[],
    now: number,
    startHistory: string[],
): AgendaEvent | null {
    const first = firstTimedOf(events, nextMorningYmd(now));
    if (!first) return null;
    const start = minutesOf(first.start!)!;
    const threshold = Math.max(
        EARLY_DEFAULT_MIN,
        medianStart(startHistory) ?? 0,
    );
    return start < threshold ? first : null;
}

/** Agenda proche brut (1 h en arrière, 24 h en avant) — aucune annotation LLM. */
export function todayFacts(events: AgendaEvent[], now: number): Fact[] {
    return events
        .filter((ev) => {
            const start = startMs(ev);
            return start >= now - HOUR_MS && start <= now + DAY_MS;
        })
        .slice(0, SNAPSHOT_MAX)
        .map((ev) => ({
            label: 'Agenda',
            value: `${ev.title}${ev.start ? ` à ${ev.start}` : ''}${
                ev.location ? ` (${ev.location})` : ''
            }`,
        }));
}

function isEvening(now: number): boolean {
    const h = new Date(now).getHours();
    return h >= EVENING_FROM_H || h < EVENING_TO_H;
}

function isWorkingDay(now: number): boolean {
    const wd = new Date(now).getDay();
    return wd >= 1 && wd <= 5;
}

export const calendarConnector: ConnectorDef = {
    id: 'calendar',
    name: 'Agenda',
    description:
        "Rappels avant les événements du calendrier ; changements d'agenda lointains (ajout, déplacement, annulation) ; agenda des 24 h et « demain tôt » dans la situation.",
    defaultEnabled: true,
    pollMinutes: 5,
    settings: [
        {
            key: 'pollMinutes',
            label: 'Intervalle (min)',
            type: 'number',
            default: 5,
        },
        {
            key: 'remindMinutesBefore',
            label: 'Rappel (min avant)',
            type: 'number',
            default: 30,
        },
        {
            key: 'maxPerHour',
            label: 'Max événements / heure',
            type: 'number',
            default: 6,
        },
    ],
    async events(ctx): Promise<Event[]> {
        const now = ctx.now();
        const cfg = {
            pollMinutes: Number(ctx.settings.pollMinutes ?? 5),
            remindMinutesBefore: Number(ctx.settings.remindMinutesBefore ?? 30),
        };
        const out: Event[] = (
            await evaluateCalendar(ctx.callTool, cfg, new Date(now))
        ).map((c) => ({
            ...fromCandidate(c, now),
            // Un rappel n'a plus de sens une fois l'événement commencé.
            ttlMs: cfg.remindMinutesBefore * 60_000,
        }));

        // Les changements ne doivent pas coûter les rappels : lecture en
        // échec → instantané intact, on comparera au prochain poll.
        try {
            const agenda = await fetchAgendaEventsCached(
                ctx.callTool,
                new Date(now),
            );
            const { events, snapshot } = diffAgenda(
                ctx.state.get<AgendaSnapshot>('agendaSnapshot', {}),
                agenda,
                now,
            );
            ctx.state.set('agendaSnapshot', snapshot);
            out.push(...events);
        } catch (err) {
            ctx.log.warn(`agenda : changements non évalués — ${err}`);
        }
        return out;
    },
    async snapshot(ctx): Promise<Fact[]> {
        const now = ctx.now();
        const events = await fetchAgendaEventsCached(
            ctx.callTool,
            new Date(now),
        );
        const facts = todayFacts(events, now);

        // Premier début de la journée, noté une fois par jour ouvré — la
        // matière de la médiane « heure habituelle ».
        const today = localYmd(now);
        let history = ctx.state.get<string[]>('startHistory', []);
        if (
            isWorkingDay(now) &&
            ctx.state.get<string | null>('startHistoryDay', null) !== today
        ) {
            const first = firstTimedOf(events, today);
            if (first) {
                history = [...history, first.start!].slice(-START_HISTORY_MAX);
                ctx.state.set('startHistory', history);
                ctx.state.set('startHistoryDay', today);
            }
        }

        if (isEvening(now)) {
            const early = earlyTomorrow(events, now, history);
            if (early) {
                facts.push({
                    label: 'Demain tôt',
                    value: `« ${early.title} » à ${early.start}`,
                    importance: 'utile',
                });
            }
        }
        return facts;
    },
};
