import { localYmd } from '../schedule/dayPlan';
import type { Wakeup } from './model';
import type { PhoneAlarm } from './store';

export interface Occurrence {
    wakeupId: string;
    at: number;
    source: 'phone' | 'fixed';
    date: string;
    wakeup: Wakeup;
}

const DAY_MS = 24 * 3600e3;
const DEDUP_MS = 5 * 60e3;

/** Réveil téléphone exploitable : futur, < 24 h, heure locale dans [03:00, 12:00). */
export function usablePhoneAlarm(
    p: PhoneAlarm | null,
    now: number,
): number | null {
    if (!p || p.nextAt === null || !Number.isFinite(p.nextAt)) return null;
    if (p.nextAt <= now || p.nextAt - now > DAY_MS) return null;
    const h = new Date(p.nextAt).getHours();
    return h >= 3 && h < 12 ? p.nextAt : null;
}

/** Prochaine occurrence d'un réveil fixe strictement après now (aujourd'hui + 7 jours). */
export function nextFixed(w: Wakeup, now: number): number | null {
    if (w.trigger.kind !== 'fixed') return null;
    const [hh, mm] = w.trigger.time.split(':').map(Number);
    const base = new Date(now);
    for (let i = 0; i < 8; i++) {
        // date locale construite à la main : pas de piège DST
        const d = new Date(
            base.getFullYear(),
            base.getMonth(),
            base.getDate() + i,
            hh,
            mm,
        );
        if (d.getTime() > now && w.trigger.days.includes(d.getDay()))
            return d.getTime();
    }
    return null;
}

/** Un réveil par date locale (le plus tôt gagne), trié par heure. */
export function pickMornings(
    wakeups: Wakeup[],
    phone: PhoneAlarm | null,
    now: number,
): Occurrence[] {
    const active = wakeups.filter((w) => w.enabled);
    const fixed: Occurrence[] = [];
    for (const w of active) {
        const at = nextFixed(w, now);
        if (at !== null)
            fixed.push({
                wakeupId: w.id,
                at,
                source: 'fixed',
                date: localYmd(new Date(at)),
                wakeup: w,
            });
    }
    const cands = [...fixed];
    const pw = active.find((w) => w.trigger.kind === 'phone');
    const pat = pw ? usablePhoneAlarm(phone, now) : null;
    if (pw && pat !== null) {
        const date = localYmd(new Date(pat));
        const dup = fixed.some(
            (f) => f.date === date && Math.abs(f.at - pat) <= DEDUP_MS,
        );
        if (!dup)
            cands.push({
                wakeupId: pw.id,
                at: pat,
                source: 'phone',
                date,
                wakeup: pw,
            });
    }
    const best = new Map<string, Occurrence>();
    for (const o of cands) {
        const cur = best.get(o.date);
        if (!cur || o.at < cur.at) best.set(o.date, o);
    }
    return [...best.values()].sort((a, b) => a.at - b.at);
}
