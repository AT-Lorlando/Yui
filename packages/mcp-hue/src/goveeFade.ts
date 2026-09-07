/**
 * Fondu logiciel pour les Govee LAN. L'API UDP (`colorwc`) n'a AUCUNE notion
 * de transition : là où une Hue fond d'elle-même sur `transitionMs`, la Govee
 * saute instantanément à la couleur cible — d'où les « steps » très secs dans
 * les scènes à couleurs flottantes. On émule donc le fondu en interpolant en
 * RGB et en envoyant une rampe de paquets (fire-and-forget, ~10/s max).
 */

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

export function hexToRgb(hex: string): Rgb {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) throw new Error(`Invalid hex color: ${hex}`);
    return {
        r: parseInt(m[1], 16),
        g: parseInt(m[2], 16),
        b: parseInt(m[3], 16),
    };
}

/** Cadence cible entre deux paquets de rampe. */
export const FADE_STEP_MS = 120;
const MAX_STEPS = 30;

/**
 * Étapes intermédiaires d'un fondu `from` → `to` sur `durationMs`.
 * La dernière étape est toujours exactement `to`. Pur, testé.
 */
export function fadeSteps(
    from: Rgb,
    to: Rgb,
    durationMs: number,
    stepMs: number = FADE_STEP_MS,
): Rgb[] {
    const n = Math.max(1, Math.min(MAX_STEPS, Math.round(durationMs / stepMs)));
    const steps: Rgb[] = [];
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        steps.push({
            r: Math.round(from.r + (to.r - from.r) * t),
            g: Math.round(from.g + (to.g - from.g) * t),
            b: Math.round(from.b + (to.b - from.b) * t),
        });
    }
    return steps;
}
