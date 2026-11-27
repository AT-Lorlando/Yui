// Matérialisation des règles d'agenda dans Google Calendar : un run liste les
// événements étiquetés `yuiRule` sur l'horizon, calcule le plan
// (planReconcile) et l'applique (retraits, mises à jour, créations).
// Runs sérialisés ; une demande pendant un run en programme exactement un de
// plus. Au démarrage (+30 s), chaque jour à 04:00 et après chaque modification.

import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import type { CallTool } from '../agendaSecretary';
import { addDays, localYmd } from '../schedule/dayPlan';
import { CalendarRule } from './model';
import {
    DesiredEvent,
    HORIZON_DAYS,
    planReconcile,
    ReconcilePlan,
    TaggedEvent,
} from './reconcile';
import { instanceId as defaultInstanceId } from './instance';
import { readRuleSet } from './store';

/** Règles valides + ids des entrées invalides du fichier (événements gelés). */
export interface RuleSet {
    rules: CalendarRule[];
    invalid: string[];
}

/** Erreur « déjà supprimé » de Google (404/410) : la suppression est acquise. */
export function isAlreadyGone(e: unknown): boolean {
    const msg = (e as Error)?.message ?? String(e);
    return /\b(404|410)\b|not found|resource has been deleted/i.test(msg);
}

export interface SyncStatus {
    at: string | null;
    ok: boolean;
    created: number;
    updated: number;
    removed: number;
    error?: string;
}

const FIRST_RUN_DELAY_MS = 30_000;
const DAILY_HOUR = 4;

const pad = (n: number) => String(n).padStart(2, '0');

/** `date` + `time` + `durationMin` → [début, fin] ISO locaux (fin peut passer minuit). */
export function timedRange(
    date: string,
    time: string,
    durationMin: number,
): [string, string] {
    const [h, m] = time.split(':').map(Number);
    const total = h * 60 + m + durationMin;
    const endDate = addDays(date, Math.floor(total / 1440));
    const rem = total % 1440;
    return [
        `${date}T${time}:00`,
        `${endDate}T${pad(Math.floor(rem / 60))}:${pad(rem % 60)}:00`,
    ];
}

function timing(w: DesiredEvent): Record<string, string> {
    if (w.allDay) return { startDate: w.date, endDate: addDays(w.date, 1) };
    const [s, e] = timedRange(w.date, w.time ?? '09:00', w.durationMin ?? 60);
    return { startDateTime: s, endDateTime: e };
}

function isTagged(v: unknown): v is TaggedEvent {
    const e = v as TaggedEvent;
    return (
        !!e &&
        typeof e.id === 'string' &&
        typeof e.calendarId === 'string' &&
        typeof e.yuiRule === 'string' &&
        typeof e.yuiDate === 'string' &&
        typeof e.date === 'string' &&
        typeof e.allDay === 'boolean' &&
        (e.yuiInstance === undefined ||
            e.yuiInstance === null ||
            typeof e.yuiInstance === 'string')
    );
}

/**
 * L'agenda principal a deux noms : l'alias 'primary' (défaut des règles) et
 * son id réel (l'email du compte). Ramène l'un et l'autre à 'primary' pour que
 * la comparaison des agendas ne voie pas un faux changement (et ne remplace
 * pas tous les événements à chaque run).
 */
export function canonicalCalendars(
    rules: CalendarRule[],
    events: TaggedEvent[],
    primaryId: string | null,
): { rules: CalendarRule[]; events: TaggedEvent[] } {
    if (!primaryId) return { rules, events };
    return {
        rules: rules.map((r) =>
            r.calendarId === primaryId ? { ...r, calendarId: 'primary' } : r,
        ),
        events: events.map((e) =>
            e.calendarId === primaryId ? { ...e, calendarId: 'primary' } : e,
        ),
    };
}

function statusFile(): string {
    return dataPath('calendar-rules-sync.json');
}

function readStatus(): SyncStatus {
    const empty: SyncStatus = {
        at: null,
        ok: false,
        created: 0,
        updated: 0,
        removed: 0,
    };
    try {
        const f = statusFile();
        if (!fs.existsSync(f)) return empty;
        return { ...empty, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch {
        return empty;
    }
}

function writeStatus(s: SyncStatus): void {
    try {
        const f = statusFile();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = `${f}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
        fs.renameSync(tmp, f);
    } catch (e) {
        Logger.warn(
            `[calendar-rules] statut non écrit : ${(e as Error).message}`,
        );
    }
}

/** Délai (ms) jusqu'au prochain 04:00 local strictement après `now`. */
export function msUntilNextDaily(now: Date, hour: number = DAILY_HOUR): number {
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
        next.setHours(hour, 0, 0, 0);
    }
    return next.getTime() - now.getTime();
}

export class CalendarRulesSync {
    private readonly callTool: CallTool;
    private readonly now: () => Date;
    private readonly readRules: () => CalendarRule[] | RuleSet;
    private readonly instanceId: () => string;
    private chain: Promise<unknown> = Promise.resolve();
    private inFlight = 0;
    private dirty = false;
    private last: SyncStatus;
    private timer: NodeJS.Timeout | null = null;

    constructor(deps: {
        callTool: CallTool;
        now?: () => Date;
        readRules?: () => CalendarRule[] | RuleSet;
        instanceId?: () => string;
    }) {
        this.callTool = deps.callTool;
        this.now = deps.now ?? (() => new Date());
        this.readRules = deps.readRules ?? readRuleSet;
        this.instanceId = deps.instanceId ?? defaultInstanceId;
        this.last = readStatus();
    }

    start(): void {
        this.stop();
        this.arm(FIRST_RUN_DELAY_MS);
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private arm(ms: number): void {
        this.timer = setTimeout(() => {
            this.timer = null;
            this.request();
            this.arm(msUntilNextDaily(this.now()));
        }, ms);
        this.timer.unref?.();
    }

    request(): void {
        if (this.inFlight > 0) {
            this.dirty = true;
            return;
        }
        this.runOnce().catch((e) =>
            Logger.warn(`[calendar-rules] sync en échec : ${String(e)}`),
        );
    }

    status(): SyncStatus {
        return { ...this.last };
    }

    runOnce(): Promise<SyncStatus> {
        this.inFlight++;
        const run = this.chain.then(() => this.doRun());
        this.chain = run.catch(() => undefined);
        return run.finally(() => {
            this.inFlight--;
            if (this.inFlight === 0 && this.dirty) {
                this.dirty = false;
                this.runOnce().catch((e) =>
                    Logger.warn(
                        `[calendar-rules] sync en échec : ${String(e)}`,
                    ),
                );
            }
        });
    }

    private async doRun(): Promise<SyncStatus> {
        const now = this.now();
        const today = localYmd(now);
        const st: SyncStatus = {
            at: now.toISOString(),
            ok: true,
            created: 0,
            updated: 0,
            removed: 0,
        };
        const finish = (): SyncStatus => {
            this.last = st;
            writeStatus(st);
            return { ...st };
        };

        let me: string;
        try {
            me = this.instanceId();
        } catch (e) {
            st.ok = false;
            st.error = `Identifiant d'instance illisible : ${
                (e as Error).message
            }`;
            Logger.warn(`[calendar-rules] ${st.error}`);
            return finish();
        }

        let existing: TaggedEvent[];
        let scanned: string[];
        let primaryId: string | null = null;
        try {
            const res = (await this.callTool('list_tagged_events', {
                startDate: today,
                endDate: addDays(today, HORIZON_DAYS),
            })) as { events?: unknown };
            if (!res || typeof res !== 'object' || !Array.isArray(res.events))
                throw new Error('réponse de list_tagged_events invalide');
            if (!res.events.every(isTagged))
                throw new Error('événement étiqueté invalide');
            const sc = (res as { scanned?: unknown }).scanned;
            if (!Array.isArray(sc) || !sc.every((x) => typeof x === 'string'))
                throw new Error(
                    'agendas parcourus inconnus (mcp-calendar à jour ?)',
                );
            scanned = sc as string[];
            // Seuls NOS événements : ceux d'une autre instance (dev/prod sur le
            // même compte) ou sans instance ne sont ni touchés ni comptés.
            existing = (res.events as TaggedEvent[]).filter(
                (e) => e.yuiInstance === me,
            );
            const pid = (res as { primaryId?: unknown }).primaryId;
            if (typeof pid === 'string' && pid) primaryId = pid;
        } catch (e) {
            // Listing partiel ou en panne : on n'écrit RIEN (ni doublon ni retrait).
            st.ok = false;
            st.error = `Lecture de l'agenda impossible : ${
                (e as Error).message
            }`;
            Logger.warn(`[calendar-rules] ${st.error}`);
            return finish();
        }

        let plan: ReconcilePlan;
        let writable: Set<string>;
        try {
            const read = this.readRules();
            const set: RuleSet = Array.isArray(read)
                ? { rules: read, invalid: [] }
                : read;
            // Règle invalide dans le fichier : ses événements sont gelés (ni
            // retirés ni modifiés) jusqu'à ce qu'elle soit corrigée.
            const frozen = new Set(set.invalid);
            const canon = canonicalCalendars(
                set.rules.filter((r) => !frozen.has(r.id)),
                existing.filter((e) => !frozen.has(e.yuiRule)),
                primaryId,
            );
            writable = new Set(
                scanned.map((id) =>
                    primaryId && id === primaryId ? 'primary' : id,
                ),
            );
            plan = planReconcile(canon.rules, canon.events, now, HORIZON_DAYS);
        } catch (e) {
            // Jamais de rejet : runOnce est lancé en `void` par request().
            st.ok = false;
            st.error = `Règles inexploitables : ${
                (e as Error)?.message ?? String(e)
            }`;
            Logger.warn(`[calendar-rules] ${st.error}`);
            return finish();
        }
        const fail = (what: string, e: unknown) => {
            const msg = `${what} : ${(e as Error)?.message ?? String(e)}`;
            Logger.warn(`[calendar-rules] ${msg}`);
            st.ok = false;
            if (!st.error) st.error = msg;
        };

        for (const ev of plan.remove) {
            try {
                await this.callTool('delete_event', {
                    calendarId: ev.calendarId,
                    eventId: ev.id,
                });
                st.removed++;
            } catch (e) {
                if (isAlreadyGone(e)) {
                    st.removed++;
                    continue;
                }
                fail(`Suppression de « ${ev.title} » (${ev.yuiDate})`, e);
            }
        }
        for (const { event, want } of plan.update) {
            try {
                const args: Record<string, unknown> = {
                    calendarId: event.calendarId,
                    eventId: event.id,
                    title: want.title,
                    ...timing(want),
                };
                if (want.description !== undefined)
                    args.description = want.description;
                await this.callTool('update_event', args);
                st.updated++;
            } catch (e) {
                fail(`Mise à jour de « ${want.title} » (${want.date})`, e);
            }
        }
        const missing = new Set<string>();
        for (const want of plan.create) {
            // Agenda jamais parcouru (masqué, absent, faute de frappe) : créer
            // ferait un doublon à chaque run, l'événement restant invisible.
            if (!writable.has(want.calendarId)) {
                missing.add(want.calendarId);
                continue;
            }
            try {
                const args: Record<string, unknown> = {
                    calendarId: want.calendarId,
                    title: want.title,
                    ...timing(want),
                    privateProperties: {
                        yuiRule: want.ruleId,
                        yuiDate: want.date,
                        yuiInstance: me,
                    },
                };
                if (want.description !== undefined)
                    args.description = want.description;
                await this.callTool('create_event', args);
                st.created++;
            } catch (e) {
                fail(`Création de « ${want.title} » (${want.date})`, e);
            }
        }

        if (missing.size) {
            const msg = `Agenda introuvable ou non modifiable : ${[
                ...missing,
            ].join(', ')}`;
            Logger.warn(`[calendar-rules] ${msg}`);
            st.ok = false;
            st.error = st.error ? `${st.error} ; ${msg}` : msg;
        }

        if (st.created || st.updated || st.removed || !st.ok)
            Logger.info(
                `[calendar-rules] sync : +${st.created} ~${st.updated} -${
                    st.removed
                }${st.error ? ` (erreur : ${st.error})` : ''}`,
            );
        return finish();
    }
}

let current: CalendarRulesSync | null = null;

export function setCalendarRulesSync(s: CalendarRulesSync | null): void {
    current = s;
}

export function getCalendarRulesSync(): CalendarRulesSync | null {
    return current;
}
