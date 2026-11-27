// Rappels par type — phase 1, mode OMBRE : chaque minute, le contexte est
// reconstruit, les politiques pures (`dueReminders`) disent ce qui est dû, et
// ce qui AURAIT été dit/notifié est écrit au journal (`shadow: true`,
// `channel: 'skip'`). Jamais de notify/speak ici.
//
// Registre `reminders-shadow.json` `{clé: at}` : écrit AVANT le journal (comme
// les marques des réveils) — un redémarrage juste après un tick ne rejoue
// jamais un rappel. Premier passage (fichier absent) : les colis déjà dans un
// état notable sont amorcés en silence.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';
import {
    fetchAgendaEventsCached,
    isAgendaReadFailure,
    type AgendaEvent,
    type CallTool,
} from '../../agendaSecretary';
import { addDays, localYmd } from '../../schedule/dayPlan';
import { getDayPlans } from '../../schedule/service';
import type { Event } from '../events';
import type { JournalEntry } from '../journal';
import type { Situation } from '../situation';
import { departDue, dueReminders } from './policies';
import { mergeTexts } from './templates';
import type {
    ParcelInfo,
    Reminder,
    ReminderContext,
    ReminderSettings,
} from './types';

export interface ReminderRunnerDeps {
    /** Fermeture unique du moteur : le cache d'agenda est indexé par elle. */
    callTool: CallTool;
    journal: { record(e: Omit<JournalEntry, 'id'>): unknown };
    presenceState(): 'home' | 'away' | 'unknown';
    subscribePresence(cb: (prev: string, next: string) => void): () => void;
    getSituation(): Situation | null;
    heldList(): Event[];
    /** Filtre optionnel des mails/notes déjà dits. */
    isSaid?(subject: string): boolean;
    todayWake(
        date: string,
    ): { at: number; afterMin: number; device: string | null } | null;
    listParcels(): ParcelInfo[];
    settings(): ReminderSettings;
    quietHours(): { start: string; end: string };
    /** Brique `reminders` active — relue à chaque tick d'intervalle. */
    enabled?(): boolean;
    now?: () => Date;
}

const MIN = 60_000;
const TICK_MS = 60_000;
const FIRST_TICK_MS = 5_000;
const KEEP_MS = 3 * 24 * 3600_000;
const FILE = 'reminders-shadow.json';
const IMPORTANCE_RANK: Record<string, number> = {
    critique: 0,
    urgent: 1,
    utile: 2,
    info: 3,
};
const PERIOD_END_HOUR: Record<string, number> = {
    night: 6,
    morning: 12,
    afternoon: 18,
    evening: 24,
};

type Registry = Record<string, number>;

/** null = fichier absent (premier passage). */
function readRegistry(): Registry | null {
    const f = dataPath(FILE);
    try {
        if (!fs.existsSync(f)) return null;
        const r = JSON.parse(fs.readFileSync(f, 'utf8'));
        return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    } catch (e) {
        Logger.warn(`[reminders] ${f} illisible : ${(e as Error).message}`);
        return {};
    }
}

function writeRegistry(reg: Registry): void {
    const f = dataPath(FILE);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, f);
}

function parseJson(raw: unknown): any {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/** « pluie » si une période d'aujourd'hui pas encore finie est pluvieuse. */
export function notableWeather(raw: unknown, now: Date): string | null {
    const data = parseJson(raw);
    const periods = Array.isArray(data?.periods) ? data.periods : [];
    const hour = now.getHours();
    for (const p of periods) {
        const end = PERIOD_END_HOUR[String(p?.period)];
        if (end !== undefined && end <= hour) continue;
        if (
            Number(p?.precipitation_prob) >= 50 ||
            Number(p?.precipitation_mm) >= 2
        )
            return 'pluie';
    }
    return null;
}

// `mail-notify-*` : « Mail — X : « … » » ; `mail-info-*` : « Courrier — X : … ».
const MAIL_SENDER_RE = /^(?:Mail|Courrier) — (.+?) : «/;
const POSTIT_AGE_RE = /\s*\(\d+ j\)$/;

export class ReminderRunner {
    private timer: ReturnType<typeof setInterval> | null = null;
    private firstTimer: ReturnType<typeof setTimeout> | null = null;
    private unsubscribe: (() => void) | null = null;
    private busy = false;
    private lastDepartureAt: number | null = null;
    private returnedAt: number | null = null;
    private readonly now: () => Date;

    constructor(private readonly deps: ReminderRunnerDeps) {
        this.now = deps.now ?? (() => new Date());
    }

    start(): void {
        if (this.timer) return;
        this.unsubscribe = this.deps.subscribePresence((prev, next) =>
            this.onPresence(prev, next),
        );
        const run = () => {
            if (this.deps.enabled && !this.deps.enabled()) return;
            void this.tick();
        };
        this.timer = setInterval(run, TICK_MS);
        this.timer.unref?.();
        this.firstTimer = setTimeout(run, FIRST_TICK_MS);
        this.firstTimer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        if (this.firstTimer) clearTimeout(this.firstTimer);
        this.timer = null;
        this.firstTimer = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    private onPresence(prev: string, next: string): void {
        const t = this.now().getTime();
        if (prev === 'home' && next === 'away') this.lastDepartureAt = t;
        if (prev !== 'home' && next === 'home') this.returnedAt = t;
    }

    /** Un seul tick à la fois ; ne lève jamais. */
    async tick(): Promise<Reminder[]> {
        if (this.busy) return [];
        this.busy = true;
        try {
            return await this.tickOnce();
        } catch (e) {
            Logger.error(`[reminders] tick : ${(e as Error).message}`);
            return [];
        } finally {
            this.busy = false;
        }
    }

    private async tickOnce(): Promise<Reminder[]> {
        const now = this.now();
        const nowMs = now.getTime();
        const stored = readRegistry();
        const firstRun = stored === null;
        const reg: Registry = {};
        for (const [k, at] of Object.entries(stored ?? {})) {
            if (typeof at === 'number' && nowMs - at < KEEP_MS) reg[k] = at;
        }
        const done = (k: string) => k in reg;

        const ctx = await this.buildContext(now);
        if (departDue(ctx, done).length > 0) {
            ctx.weather = await this.weather(now);
        }
        let due = dueReminders(ctx, done);

        if (firstRun) {
            for (const r of due)
                if (r.key.startsWith('parcel:')) reg[r.key] = nowMs;
            due = due.filter((r) => !r.key.startsWith('parcel:'));
        }
        for (const r of due) reg[r.key] = nowMs;
        const purged =
            stored !== null &&
            Object.keys(reg).length !== Object.keys(stored).length;
        // AVANT le journal : un redémarrage ne rejoue jamais un rappel.
        if (firstRun || purged || due.length > 0) writeRegistry(reg);
        if (due.length === 0) return [];

        const merged = mergeTexts(due);
        const wantsSpeech = due.some((r) => r.wantsSpeech);
        const device = due.find((r) => r.device)?.device;
        const reason =
            (wantsSpeech && ctx.presence === 'home'
                ? 'aurait parlé'
                : 'aurait notifié') + (device ? ` (${device})` : '');
        try {
            this.deps.journal.record({
                at: nowMs,
                source: 'reminders',
                subject: due.map((r) => r.key).join(','),
                channel: 'skip',
                shadow: true,
                message: merged.notif,
                reason,
                facts: [merged.spoken],
            });
        } catch (e) {
            Logger.warn(`[reminders] journal : ${(e as Error).message}`);
        }
        Logger.info(`[reminders] (ombre) ${due.map((r) => r.key).join(', ')}`);
        return due;
    }

    private async buildContext(now: Date): Promise<ReminderContext> {
        const { deps } = this;
        const today = localYmd(now);
        const tomorrow = addDays(today, 1);

        let events: AgendaEvent[] = [];
        let calendarOk = false;
        try {
            events = await fetchAgendaEventsCached(deps.callTool, now);
            calendarOk = !isAgendaReadFailure(events);
            if (!calendarOk) Logger.warn('[reminders] agenda illisible');
        } catch (e) {
            Logger.warn(`[reminders] agenda : ${(e as Error).message}`);
        }
        const { plans } = await getDayPlans(deps.callTool, today, 2, now);

        const said = (subject: string) => {
            try {
                return deps.isSaid?.(subject) === true;
            } catch {
                return false;
            }
        };
        const held = safe(() => deps.heldList(), [] as Event[]);
        const mails: string[] = [];
        let mailCount = 0;
        for (const e of held) {
            if (!/^mail-(notify|info)-/.test(e.key) || said(e.subject))
                continue;
            mailCount++;
            const who = MAIL_SENDER_RE.exec(e.subject)?.[1]?.trim();
            if (who && !mails.includes(who)) mails.push(who);
        }
        const notes = held
            .filter((e) => e.source !== 'mail' && !said(e.subject))
            .sort(
                (a, b) =>
                    (IMPORTANCE_RANK[a.importance] ?? 9) -
                    (IMPORTANCE_RANK[b.importance] ?? 9),
            )
            .slice(0, 2)
            .map((e) => e.subject);
        const situation = safe(() => deps.getSituation(), null);
        const postits = (situation?.sections?.yoji ?? [])
            .filter((f) => f.label === 'Post-it ancien')
            .slice(0, 2)
            .map((f) => String(f.value).replace(POSTIT_AGE_RE, ''));

        return {
            now,
            today,
            tomorrow,
            presence: deps.presenceState(),
            quietHours: deps.quietHours(),
            plans: {
                today: plans.find((p) => p.date === today) ?? null,
                tomorrow: plans.find((p) => p.date === tomorrow) ?? null,
            },
            events,
            calendarOk,
            wake: safe(() => deps.todayWake(today), null),
            parcels: safe(() => deps.listParcels(), [] as ParcelInfo[]),
            mails,
            mailCount,
            postits,
            notes,
            weather: null,
            lastDepartureAt: this.lastDepartureAt,
            returnedAt: this.returnedAt,
            settings: deps.settings(),
        };
    }

    private async weather(
        now: Date,
    ): Promise<{ notable: string | null } | null> {
        try {
            const raw = await this.deps.callTool('get_today_forecast', {});
            return { notable: notableWeather(raw, now) };
        } catch (e) {
            Logger.warn(`[reminders] météo : ${(e as Error).message}`);
            return null;
        }
    }
}

function safe<T>(fn: () => T, fallback: T): T {
    try {
        return fn();
    } catch (e) {
        Logger.warn(`[reminders] contexte : ${(e as Error).message}`);
        return fallback;
    }
}
