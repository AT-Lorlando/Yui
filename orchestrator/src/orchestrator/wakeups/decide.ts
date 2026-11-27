import type { Occurrence } from './occurrences';

/** Horodatages d'exécution : une marque posée = jamais rejoué. */
export interface RunMarks {
    lights?: number;
    brief?: number;
    skipped?: boolean;
}
export type Action =
    | { kind: 'lights'; rampMs: number }
    | { kind: 'brief' }
    | { kind: 'skip' };

const MIN_RAMP_MS = 60_000;
export const GRACE_MS = 30 * 60_000;

export function occKey(o: Occurrence): string {
    return `${o.date}@${o.at}`;
}

/** Actions dues pour une occurrence à l'instant `now` (pur). */
export function decide(o: Occurrence, marks: RunMarks, now: number): Action[] {
    const T = o.at;
    const out: Action[] = [];
    const l = o.wakeup.lights;
    if (l && !marks.lights) {
        const L = T - l.rampMin * 60_000;
        // montée en retard : durée restante, au moins 1 min ; fenêtre passée : rien
        if (L <= now && now < T)
            out.push({
                kind: 'lights',
                rampMs: Math.max(MIN_RAMP_MS, T - now),
            });
    }
    const b = o.wakeup.brief;
    let B = T;
    if (b) {
        B = T + b.afterMin * 60_000;
        // fenêtre du point : B ≤ now < B + GRACE (afterMin ≥ 30 part aussi)
        if (!marks.brief && B <= now && now < B + GRACE_MS)
            out.push({ kind: 'brief' });
    }
    if (now >= T + GRACE_MS && now >= B + GRACE_MS && !marks.skipped)
        out.push({ kind: 'skip' });
    return out;
}
