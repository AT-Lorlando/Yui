export interface WakeLights {
    room: string;
    rampMin: number;
    from: string;
    to: number;
    toBrightness: number;
}
export interface WakeBrief {
    afterMin: number;
    speak: string | null;
    notify: boolean;
}
/** days : 0 = dimanche … 6 = samedi */
export type WakeTrigger =
    | { kind: 'phone' }
    | { kind: 'fixed'; time: string; days: number[] };
export interface Wakeup {
    id: string;
    name: string;
    enabled: boolean;
    trigger: WakeTrigger;
    lights: WakeLights | null;
    brief: WakeBrief | null;
}

export const DEFAULT_LIGHTS: WakeLights = Object.freeze({
    room: 'Chambre',
    rampMin: 15,
    from: '#ff8a3d',
    to: 2700,
    toBrightness: 80,
});
export const DEFAULT_BRIEF: WakeBrief = Object.freeze({
    afterMin: 5,
    speak: 'Chambre',
    notify: true,
});
export const DEFAULT_WAKEUPS: Wakeup[] = [
    {
        id: 'semaine',
        name: 'Semaine',
        enabled: true,
        trigger: { kind: 'phone' },
        lights: { ...DEFAULT_LIGHTS },
        brief: { ...DEFAULT_BRIEF },
    },
];

const MAX_WAKEUPS = 10;

function obj(v: unknown, what: string): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new Error(`${what} invalide`);
    return v as Record<string, unknown>;
}

function int(v: unknown, min: number, max: number, what: string): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
        throw new Error(`${what} : entier entre ${min} et ${max} attendu`);
    return v;
}

function normalizeTrigger(t: unknown): WakeTrigger {
    const r = obj(t, 'Déclencheur');
    if (r.kind === 'phone') return { kind: 'phone' };
    if (r.kind !== 'fixed') throw new Error('Déclencheur : type inconnu');
    if (typeof r.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time))
        throw new Error('Heure invalide (HH:MM)');
    if (!Array.isArray(r.days) || r.days.length === 0)
        throw new Error('Choisis au moins un jour');
    const days = [...new Set(r.days.map((d) => int(d, 0, 6, 'Jour')))].sort(
        (a, b) => a - b,
    );
    return { kind: 'fixed', time: r.time, days };
}

function normalizeLights(l: unknown): WakeLights | null {
    if (l === null) return null;
    const r = l === undefined ? {} : obj(l, 'Lumières');
    const room = r.room ?? DEFAULT_LIGHTS.room;
    if (typeof room !== 'string' || !room.trim())
        throw new Error('Pièce des lumières invalide');
    const from = r.from ?? DEFAULT_LIGHTS.from;
    if (typeof from !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(from))
        throw new Error('Couleur de départ invalide (#rrggbb)');
    return {
        room: room.trim(),
        rampMin: int(
            r.rampMin ?? DEFAULT_LIGHTS.rampMin,
            1,
            60,
            'Montée (min)',
        ),
        from,
        to: int(r.to ?? DEFAULT_LIGHTS.to, 2000, 6500, 'Température (K)'),
        toBrightness: int(
            r.toBrightness ?? DEFAULT_LIGHTS.toBrightness,
            1,
            100,
            'Luminosité',
        ),
    };
}

function normalizeBrief(b: unknown): WakeBrief | null {
    if (b === null) return null;
    const r = b === undefined ? {} : obj(b, 'Point du matin');
    const speak = r.speak === undefined ? DEFAULT_BRIEF.speak : r.speak;
    if (speak !== null && (typeof speak !== 'string' || !speak.trim()))
        throw new Error('Enceinte du point du matin invalide');
    const notify = r.notify === undefined ? DEFAULT_BRIEF.notify : r.notify;
    if (typeof notify !== 'boolean') throw new Error('Notification invalide');
    return {
        afterMin: int(
            r.afterMin ?? DEFAULT_BRIEF.afterMin,
            0,
            60,
            'Délai (min)',
        ),
        speak: speak === null ? null : (speak as string).trim(),
        notify,
    };
}

export function normalizeWakeup(w: unknown): Wakeup {
    const r = obj(w, 'Réveil');
    if (typeof r.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(r.id))
        throw new Error('Identifiant invalide (a-z, 0-9, tirets, 32 max)');
    if (
        typeof r.name !== 'string' ||
        r.name.trim().length < 1 ||
        r.name.trim().length > 40
    )
        throw new Error('Nom : 1 à 40 caractères');
    const enabled = r.enabled === undefined ? true : r.enabled;
    if (typeof enabled !== 'boolean') throw new Error('Activation invalide');
    return {
        id: r.id,
        name: r.name.trim(),
        enabled,
        trigger: normalizeTrigger(r.trigger),
        lights: normalizeLights(r.lights),
        brief: normalizeBrief(r.brief),
    };
}

export function normalizeWakeups(list: unknown): Wakeup[] {
    if (!Array.isArray(list)) throw new Error('Liste de réveils invalide');
    if (list.length > MAX_WAKEUPS)
        throw new Error(`${MAX_WAKEUPS} réveils maximum`);
    const out = list.map(normalizeWakeup);
    const ids = new Set(out.map((w) => w.id));
    if (ids.size !== out.length) throw new Error('Identifiants en doublon');
    if (out.filter((w) => w.trigger.kind === 'phone').length > 1)
        throw new Error('Un seul réveil peut suivre le téléphone');
    return out;
}
