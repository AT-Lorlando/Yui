import GoveeClient from './GoveeClient';
import Logger from './logger';

/**
 * Background ambiance runner — animates a Govee RGB channel through a palette
 * (smooth crossfade), optionally pulsing brightness. One active animation per
 * device id at a time; starting a new one stops the previous.
 *
 * All animations run as a setInterval loop sending `colorwc` periodically.
 * The Govee LAN broadcasts to all currently-active RGB zones, so the visual
 * applies to whatever the user has activated in the Govee app.
 */

export interface PresetSpec {
    id: string;
    name: string;
    description: string;
    palette: string[]; // hex colors
    stepMs: number; // cross-fade granularity (smaller = smoother, more packets)
    cycleMs: number; // duration of one full palette loop
    pulse?: { minBri: number; maxBri: number; periodMs: number }; // optional brightness breathe
}

export const PRESETS: PresetSpec[] = [
    {
        id: 'aurora',
        name: 'Aurora',
        description: 'Voiles vert/bleu/violet lents — boréal',
        palette: ['#003D2A', '#00B894', '#0984E3', '#6C5CE7', '#00CEC9'],
        stepMs: 400,
        cycleMs: 60_000,
        pulse: { minBri: 35, maxBri: 75, periodMs: 18_000 },
    },
    {
        id: 'sunset',
        name: 'Sunset',
        description: 'Coucher de soleil — ambre, corail, magenta',
        palette: ['#FF4500', '#FF8C00', '#FF6B6B', '#C71585', '#8B0038'],
        stepMs: 400,
        cycleMs: 45_000,
        pulse: { minBri: 50, maxBri: 90, periodMs: 12_000 },
    },
    {
        id: 'ocean',
        name: 'Océan',
        description: 'Vagues bleu profond → turquoise',
        palette: ['#003049', '#0077B6', '#00B4D8', '#90E0EF', '#0096C7'],
        stepMs: 350,
        cycleMs: 50_000,
        pulse: { minBri: 30, maxBri: 70, periodMs: 14_000 },
    },
    {
        id: 'fire',
        name: 'Feu de camp',
        description: 'Flammes orange/rouge vacillantes',
        palette: ['#FF0000', '#FF4500', '#FF6B00', '#8B0000', '#FF8C00'],
        stepMs: 250,
        cycleMs: 18_000,
        pulse: { minBri: 40, maxBri: 95, periodMs: 4_000 },
    },
    {
        id: 'rainbow',
        name: 'Arc-en-ciel',
        description: 'Roue chromatique complète — démo',
        palette: [
            '#FF0000',
            '#FF8800',
            '#FFFF00',
            '#00FF00',
            '#00FFFF',
            '#0000FF',
            '#8800FF',
            '#FF00FF',
        ],
        stepMs: 250,
        cycleMs: 30_000,
    },
    {
        id: 'rave',
        name: 'Rave',
        description: 'Flashes magenta/cyan/vert rapides',
        palette: ['#FF00FF', '#00FF00', '#00FFFF', '#FFFF00'],
        stepMs: 200,
        cycleMs: 4_000,
        pulse: { minBri: 60, maxBri: 100, periodMs: 1_500 },
    },
    {
        id: 'lavande',
        name: 'Lavande',
        description: "Pourpre doux, parfait pour s'endormir",
        palette: ['#3D2A5E', '#6C4F8C', '#9B6FCE', '#C9A0DC'],
        stepMs: 500,
        cycleMs: 90_000,
        pulse: { minBri: 15, maxBri: 35, periodMs: 25_000 },
    },
];

interface ActiveLoop {
    deviceId: string;
    presetId: string;
    timer: NodeJS.Timeout;
    pulseTimer?: NodeJS.Timeout;
    startedAt: number;
}

const active = new Map<string, ActiveLoop>(); // key: device id

function hexToRgb(hex: string): [number, number, number] {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)!;
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
    const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function sampleGradient(palette: string[], t: number): string {
    // t ∈ [0, 1) — cycles palette[0] → palette[1] → … → palette[0]
    const segments = palette.length;
    const pos = t * segments;
    const i = Math.floor(pos) % segments;
    const next = (i + 1) % segments;
    const frac = pos - Math.floor(pos);
    const [r1, g1, b1] = hexToRgb(palette[i]);
    const [r2, g2, b2] = hexToRgb(palette[next]);
    return rgbToHex(lerp(r1, r2, frac), lerp(g1, g2, frac), lerp(b1, b2, frac));
}

function sampleSineBrightness(
    minBri: number,
    maxBri: number,
    periodMs: number,
    elapsed: number,
): number {
    // Half-cosine: starts at min, peaks at half-period.
    const phase = (elapsed % periodMs) / periodMs; // 0..1
    const wave = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI); // 0..1
    return minBri + (maxBri - minBri) * wave;
}

export function stopAmbiance(deviceId: string): boolean {
    const loop = active.get(deviceId);
    if (!loop) return false;
    clearInterval(loop.timer);
    if (loop.pulseTimer) clearInterval(loop.pulseTimer);
    active.delete(deviceId);
    Logger.info(`[govee-ambiance] stopped ${loop.presetId} on ${deviceId}`);
    return true;
}

export function startAmbiance(
    deviceId: string,
    presetId: string,
    client: GoveeClient,
): PresetSpec {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) {
        throw new Error(
            `Preset "${presetId}" introuvable. Disponibles: ${PRESETS.map(
                (p) => p.id,
            ).join(', ')}`,
        );
    }
    stopAmbiance(deviceId);

    const startedAt = Date.now();
    // Color loop: sample gradient and push every stepMs.
    let lastColor = '';
    const colorTick = () => {
        const elapsed = Date.now() - startedAt;
        const t = (elapsed % preset.cycleMs) / preset.cycleMs;
        const hex = sampleGradient(preset.palette, t);
        if (hex === lastColor) return; // skip duplicate sends
        lastColor = hex;
        client.color(hex).catch(() => {
            /* swallow — UDP fire-and-forget */
        });
    };
    colorTick(); // immediate first frame
    const timer = setInterval(colorTick, preset.stepMs);

    // Brightness pulse (slower, less spammy).
    let pulseTimer: NodeJS.Timeout | undefined;
    if (preset.pulse) {
        const briStep = Math.max(
            500,
            Math.min(2000, preset.pulse.periodMs / 20),
        );
        const pulseTick = () => {
            const elapsed = Date.now() - startedAt;
            const bri = sampleSineBrightness(
                preset.pulse!.minBri,
                preset.pulse!.maxBri,
                preset.pulse!.periodMs,
                elapsed,
            );
            client.brightness(bri).catch(() => {});
        };
        pulseTick();
        pulseTimer = setInterval(pulseTick, briStep);
    }

    active.set(deviceId, { deviceId, presetId, timer, pulseTimer, startedAt });
    Logger.info(`[govee-ambiance] started "${preset.name}" on ${deviceId}`);
    return preset;
}

export function listAmbiance(): Array<{
    id: string;
    name: string;
    description: string;
    running: boolean;
}> {
    const runningIds = new Set([...active.values()].map((a) => a.presetId));
    return PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        running: runningIds.has(p.id),
    }));
}

export function stopAllAmbiance(): void {
    for (const id of [...active.keys()]) stopAmbiance(id);
}
