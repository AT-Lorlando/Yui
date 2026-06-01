export function hexToRgb(hex: string): [number, number, number] {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) throw new Error(`Invalid hex color: ${hex}`);
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
    const h = (n: number) =>
        Math.round(Math.max(0, Math.min(255, n)))
            .toString(16)
            .padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Sample a looping gradient. t ∈ [0,1) cycles palette[0]→…→palette[0]. */
export function sampleGradient(palette: string[], t: number): string {
    if (palette.length === 0) throw new Error('Empty palette');
    if (palette.length === 1) return palette[0].toLowerCase();
    const norm = ((t % 1) + 1) % 1; // handle t=1 and negatives
    const segments = palette.length;
    const pos = norm * segments;
    const i = Math.floor(pos) % segments;
    const next = (i + 1) % segments;
    const frac = pos - Math.floor(pos);
    const [r1, g1, b1] = hexToRgb(palette[i]);
    const [r2, g2, b2] = hexToRgb(palette[next]);
    return rgbToHex(lerp(r1, r2, frac), lerp(g1, g2, frac), lerp(b1, b2, frac));
}
