import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import { fetchAgendaEventsCached, type CallTool } from '../agendaSecretary';
import { morningBrief } from '../proactive/reminders/format';
import { localYmd } from '../schedule/dayPlan';
import { decide, occKey, GRACE_MS, type RunMarks } from './decide';
import type { Wakeup } from './model';
import { pickMornings, type Occurrence } from './occurrences';
import { readPhoneAlarm, readWakeups } from './store';

export interface WakeupDeps {
    callTool: CallTool; // chemin GARDÉ (orchestrator.callTool)
    notify(text: string): Promise<void>;
    speak(text: string, device: string): Promise<boolean>;
    presence(): 'home' | 'away' | 'unknown';
    /** Appelé quand le réveil du jour a pris le relais (montée ou point du matin). */
    onWakeHandled?(now: number): void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export class WakeupNotFoundError extends Error {}

const TICK_MS = 30_000;
const GAP_MS = 1_500;
const KEEP_MS = 3 * 24 * 3600e3;

/** Entrée de wakeup-runs.json : marques + occurrence vue (le réveil
 *  téléphone disparaît du fichier dès qu'il a sonné, le point du matin doit
 *  pourtant partir 5 min plus tard). */
type RunEntry = RunMarks & { occ?: Occurrence };
type Runs = Record<string, RunEntry>;

function readRuns(): Runs {
    const f = dataPath('wakeup-runs.json');
    try {
        if (!fs.existsSync(f)) return {};
        const r = JSON.parse(fs.readFileSync(f, 'utf8'));
        return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    } catch (e) {
        Logger.warn(`[wakeups] ${f} illisible : ${(e as Error).message}`);
        return {};
    }
}

function writeRuns(runs: Runs): void {
    const f = dataPath('wakeup-runs.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(runs, null, 2));
    fs.renameSync(tmp, f);
}

function parseLights(raw: unknown): any[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const v = JSON.parse(raw);
            return Array.isArray(v) ? v : [];
        } catch {
            return [];
        }
    }
    return [];
}

export class WakeupRunner {
    private timer: NodeJS.Timeout | null = null;
    private busy = false;
    private rerun = false;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly deps: WakeupDeps) {
        this.now = deps.now ?? Date.now;
        this.sleep =
            deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_MS);
        this.timer.unref?.();
        void this.tick();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    reschedule(): void {
        void this.tick();
    }

    next(): Occurrence[] {
        return pickMornings(readWakeups(), readPhoneAlarm(), this.now());
    }

    /**
     * Réveil du jour `date` (passé ou à venir) : le plus tôt des occurrences
     * vues (marques de wakeup-runs.json — un réveil téléphone disparaît de
     * phone-alarm.json dès qu'il a sonné), sinon `next()`. Lecture seule.
     * null si aucun réveil ce jour-là ou s'il n'a pas de point du matin.
     */
    todayWake(
        date: string,
    ): { at: number; afterMin: number; device: string | null } | null {
        const wakeups = readWakeups();
        const candidates: Occurrence[] = [];
        for (const e of Object.values(readRuns())) {
            if (e?.occ?.date === date) candidates.push(e.occ);
        }
        for (const o of this.next()) if (o.date === date) candidates.push(o);
        candidates.sort((a, b) => a.at - b.at);
        for (const o of candidates) {
            const w = wakeups.find((x) => x.id === o.wakeupId);
            if (!w || !w.enabled) continue;
            if (!w.brief) return null;
            return {
                at: o.at,
                afterMin: w.brief.afterMin,
                device: w.brief.speak,
            };
        }
        return null;
    }

    async tick(): Promise<void> {
        if (this.busy) {
            this.rerun = true;
            return;
        }
        this.busy = true;
        try {
            do {
                this.rerun = false;
                await this.tickOnce();
            } while (this.rerun);
        } catch (e) {
            Logger.error(`[wakeups] tick : ${(e as Error).message}`);
        } finally {
            this.busy = false;
        }
    }

    private async tickOnce(): Promise<void> {
        const now = this.now();
        const wakeups = readWakeups();
        const phone = readPhoneAlarm();
        const runs = readRuns();
        let dirty = this.mergeSeen(runs, wakeups, phone, now);

        // un seul réveil par matin : le plus tôt
        const byDate = new Map<string, string>();
        for (const [k, e] of Object.entries(runs)) {
            if (!e.occ) continue;
            const cur = byDate.get(e.occ.date);
            if (!cur || e.occ.at < (runs[cur].occ as Occurrence).at)
                byDate.set(e.occ.date, k);
        }
        const todo: { key: string; occ: Occurrence }[] = [];
        for (const [key, e] of Object.entries(runs)) {
            if (!e.occ || byDate.get(e.occ.date) !== key) continue;
            const w = wakeups.find((x) => x.id === e.occ?.wakeupId);
            if (!w || !w.enabled) continue;
            todo.push({ key, occ: { ...e.occ, wakeup: w } });
        }
        todo.sort((a, b) => a.occ.at - b.occ.at);

        let handled = false;
        const work: {
            occ: Occurrence;
            kind: 'lights' | 'brief';
            ms: number;
        }[] = [];
        for (const { key, occ } of todo) {
            const e = runs[key];
            for (const a of decide(occ, e, now)) {
                if (a.kind === 'skip') e.skipped = true;
                else if (a.kind === 'lights') {
                    if (this.deps.presence() === 'away') {
                        // absent : pas de montée, marque posée (pas de nouvelle tentative)
                        e.lights = now;
                        handled = true;
                        dirty = true;
                        continue;
                    }
                    // lecture impossible : pas de marque, on réessaie au tick suivant
                    const lit = await this.roomLit(occ.wakeup);
                    if (lit === null) continue;
                    e.lights = now;
                    handled = true;
                    if (!lit) work.push({ occ, kind: 'lights', ms: a.rampMs });
                } else {
                    e.brief = now;
                    handled = true;
                    work.push({ occ, kind: 'brief', ms: 0 });
                }
                dirty = true;
            }
        }
        // marques écrites AVANT toute écriture matérielle : au plus une fois
        if (dirty) writeRuns(runs);
        if (handled) {
            try {
                this.deps.onWakeHandled?.(now);
            } catch (e) {
                Logger.warn(
                    `[wakeups] onWakeHandled : ${(e as Error).message}`,
                );
            }
        }

        for (const w of work) {
            if (w.kind === 'lights') await this.ramp(w.occ.wakeup, w.ms);
            else await this.brief(w.occ.wakeup);
        }
    }

    /** Fusionne les occurrences vues (futures + dans la fenêtre de rattrapage). */
    private mergeSeen(
        runs: Runs,
        wakeups: Wakeup[],
        phone: ReturnType<typeof readPhoneAlarm>,
        now: number,
    ): boolean {
        let dirty = false;
        for (const [k, e] of Object.entries(runs)) {
            if (!e.occ || e.occ.at < now - KEEP_MS) {
                delete runs[k];
                dirty = true;
            }
        }
        const seen = new Map<string, Occurrence>();
        for (const t of [now, now - GRACE_MS]) {
            for (const o of pickMornings(wakeups, phone, t))
                seen.set(occKey(o), o);
        }
        // futur non marqué et plus vu (alarme coupée/déplacée, config changée) : retiré
        for (const [k, e] of Object.entries(runs)) {
            if (
                e.occ &&
                e.occ.at > now &&
                !e.lights &&
                !e.brief &&
                !e.skipped &&
                !seen.has(k)
            ) {
                delete runs[k];
                dirty = true;
            }
        }
        for (const [key, o] of seen) {
            const cur = runs[key];
            if (cur) {
                if (JSON.stringify(cur.occ) !== JSON.stringify(o)) {
                    cur.occ = o;
                    dirty = true;
                }
                continue;
            }
            runs[key] = { occ: o };
            dirty = true;
        }
        return dirty;
    }

    /** true = pièce déjà allumée, false = éteinte, null = lecture impossible. */
    private async roomLit(w: Wakeup): Promise<boolean | null> {
        const l = w.lights;
        if (!l) return false;
        try {
            const raw = await this.deps.callTool('list_lights', {});
            // callTool ne lève pas sur une erreur MCP : chaîne « Error… »
            if (typeof raw === 'string' && /^\s*error/i.test(raw)) {
                Logger.warn(`[wakeups] list_lights : ${raw}`);
                return null;
            }
            const room = l.room.toLowerCase();
            const inRoom = parseLights(raw).filter(
                (x) => (x?.room ?? '').toLowerCase() === room,
            );
            if (inRoom.length === 0) {
                Logger.warn(
                    `[wakeups] list_lights : aucune lampe pour ${l.room}`,
                );
                return null;
            }
            const on = inRoom.some(
                (x) => x?.state?.on === true || x?.on === true,
            );
            if (on)
                Logger.info(
                    `[wakeups] ${w.name} : ${l.room} déjà allumée, pas de montée`,
                );
            return on;
        } catch (e) {
            Logger.warn(`[wakeups] list_lights : ${(e as Error).message}`);
            return null;
        }
    }

    private async ramp(w: Wakeup, rampMs: number): Promise<void> {
        const l = w.lights;
        if (!l) return;
        const { callTool } = this.deps;
        try {
            const r1 = await callTool('set_lights', {
                target: l.room,
                on: true,
                color: l.from,
                brightness: 1,
                transitionMs: 0,
            });
            await this.sleep(GAP_MS);
            const r2 = await callTool('set_lights', {
                target: l.room,
                colorTemp: l.to,
                brightness: l.toBrightness,
                transitionMs: rampMs - GAP_MS,
            });
            const err = [r1, r2].find(
                (r) => typeof r === 'string' && /^\s*error/i.test(r),
            );
            if (err) Logger.warn(`[wakeups] montée en échec : ${err}`);
            else Logger.info(`[wakeups] ${w.name} : montée ${rampMs} ms`);
        } catch (e) {
            Logger.warn(`[wakeups] montée : ${(e as Error).message}`);
        }
    }

    private async brief(w: Wakeup): Promise<void> {
        const b = w.brief;
        if (!b) return;
        const now = this.now();
        let events: Awaited<ReturnType<typeof fetchAgendaEventsCached>> = [];
        try {
            events = await fetchAgendaEventsCached(
                this.deps.callTool,
                new Date(now),
            );
        } catch (e) {
            Logger.warn(`[wakeups] agenda : ${(e as Error).message}`);
        }
        const { notif, spoken } = morningBrief(localYmd(new Date(now)), events);
        if (b.notify) {
            try {
                await this.deps.notify(notif);
            } catch (e) {
                Logger.warn(`[wakeups] notif : ${(e as Error).message}`);
            }
        }
        if (b.speak && this.deps.presence() === 'home') {
            try {
                await this.deps.speak(spoken, b.speak);
            } catch (e) {
                Logger.warn(`[wakeups] parole : ${(e as Error).message}`);
            }
        }
    }

    /** Essai : montée d'1 min (sans contrôle de la pièce, sans marque), puis point du matin. */
    async test(id: string): Promise<void> {
        const w = readWakeups().find((x) => x.id === id);
        if (!w) throw new WakeupNotFoundError(id);
        if (w.lights) await this.ramp(w, 60_000);
        await this.sleep(60_000);
        await this.brief(w);
    }
}

let current: WakeupRunner | null = null;
export function setWakeupRunner(r: WakeupRunner | null): void {
    current = r;
}
export function getWakeupRunner(): WakeupRunner | null {
    return current;
}
