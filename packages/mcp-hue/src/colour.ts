/**
 * Conversions de couleur entre ce que nous écrivons (hex, kelvin), ce que le
 * bridge pousse (xy CIE 1931, mirek) et ce que le store expose (hue 0–65535,
 * saturation 0–254 — les champs v1 du bridge, HSV).
 *
 * Tout est pur : ni réseau, ni store, donc testable sans bridge.
 */

export interface HueSat {
    hue: number; // 0–65535
    sat: number; // 0–254
}

/** Plage de blanc acceptée par le bridge : mirek 153–500. */
export const KELVIN_MIN = 2000;
export const KELVIN_MAX = 6500;

/**
 * RGB sRGB (0–1, après gamma) → hue/sat au format bridge.
 *
 * Saturation HSV, pas HSL : le champ `sat` du bridge et la roue de l'app
 * (qui émet des hex à V=1) sont HSV. L'ancienne formule HSL envoyait 254
 * pour tout pastel (#ffc080 → 254 au lieu de 127) : une scène « pêche »
 * allumait la lampe en orange vif.
 */
export function rgbToHueSat(r: number, g: number, b: number): HueSat {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        switch (max) {
            case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            default:
                h = (r - g) / d + 4;
        }
        h /= 6;
    }
    const s = max > 0 ? d / max : 0;
    return {
        hue: Math.round(h * 65535) % 65536,
        sat: Math.round(s * 254),
    };
}

export function hexToHueSat(hex: string): HueSat {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) throw new Error(`Invalid hex color: ${hex}`);
    return rgbToHueSat(
        parseInt(m[1], 16) / 255,
        parseInt(m[2], 16) / 255,
        parseInt(m[3], 16) / 255,
    );
}

/** Compansion sRGB (linéaire → gamma), pour comparer avec les hex de l'app. */
function gamma(c: number): number {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * xy (CIE 1931, ce que le flux SSE v2 pousse) → hue/sat.
 *
 * Matrice XYZ → sRGB D65 : le blanc D65 tombe exactement sur r = g = b, donc
 * saturation 0 — c'est ce qui permet à l'app de ne pas afficher un blanc
 * comme une couleur. La luminosité n'entre pas en jeu : hue et saturation
 * HSV sont invariantes par mise à l'échelle uniforme des trois canaux, et on
 * normalise sur le canal max AVANT le gamma pour qu'aucun écrêtage ne fausse
 * les rapports (les primaires du gamut C sortent du sRGB).
 */
export function xyToHueSat(x: number, y: number): HueSat {
    if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) {
        return { hue: 0, sat: 0 };
    }
    const z = 1 - x - y;
    const Y = 1;
    const X = (Y / y) * x;
    const Z = (Y / y) * z;
    let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    let b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
    r = Math.max(0, r);
    g = Math.max(0, g);
    b = Math.max(0, b);
    const max = Math.max(r, g, b);
    if (max <= 0) return { hue: 0, sat: 0 };
    return rgbToHueSat(gamma(r / max), gamma(g / max), gamma(b / max));
}

/** mirek (ce que le bridge parle) → kelvin (ce que le store et l'app parlent). */
export function mirekToKelvin(
    mirek: number | null | undefined,
): number | undefined {
    if (typeof mirek !== 'number' || !Number.isFinite(mirek) || mirek <= 0) {
        return undefined;
    }
    return Math.round(1_000_000 / mirek);
}

export type ColorMode = 'hs' | 'xy' | 'ct';

export interface ColourState {
    hue?: number;
    saturation?: number;
    ct?: number; // kelvin
    colormode?: ColorMode;
}

/**
 * Ce qu'une écriture propre laisse dans le store. Le blanc prime sur la
 * couleur, comme dans HueController (ct écrase hue/sat côté bridge).
 *
 * Un hex invalide ne lève pas : l'écriture bridge a déjà levé avant d'arriver
 * ici si elle devait le faire, et un patch d'état ne doit jamais faire
 * échouer une commande qui a réussi.
 */
export function colourStatePatch(opts: {
    color?: string;
    colorTempK?: number;
}): ColourState {
    if (opts.colorTempK !== undefined && Number.isFinite(opts.colorTempK)) {
        return {
            ct: Math.max(
                KELVIN_MIN,
                Math.min(KELVIN_MAX, Math.round(opts.colorTempK)),
            ),
            colormode: 'ct',
        };
    }
    if (opts.color !== undefined) {
        try {
            const { hue, sat } = hexToHueSat(opts.color);
            return { hue, saturation: sat, colormode: 'hs' };
        } catch {
            return {};
        }
    }
    return {};
}
