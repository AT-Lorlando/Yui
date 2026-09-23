// orchestrator/src/orchestrator/animation/effects.ts
import type { AnimationEffect, Keyframe } from './types';

const DEFAULT_TRANSITION = 400;

export interface ExpandResult {
    frames: Keyframe[];
    /** Absolute ms at which this effect is fully done (incl. transition + hold). */
    endMs: number;
}

/**
 * Expand one effect into concrete keyframes.
 * @param lightNames concrete lights the target resolves to (caller-resolved)
 * @param startMs    absolute start offset (ms) from anim start
 */
/** Ordre de parcours des lampes (random : mélange stable pendant un run). */
export function orderLights(
    lightNames: string[],
    order: AnimationEffect['order'],
): string[] {
    if (order === 'reverse') return [...lightNames].reverse();
    if (order === 'random') {
        const salt = Date.now().toString(36).slice(-2);
        const scored = lightNames.map((n) => {
            let h = 2166136261;
            for (const ch of n + salt) h = (h ^ ch.charCodeAt(0)) * 16777619;
            return { n, h: h >>> 0 };
        });
        return scored.sort((a, b) => a.h - b.h).map((x) => x.n);
    }
    return lightNames;
}

export function expandEffect(
    effect: AnimationEffect,
    lightNames: string[],
    startMs: number,
): ExpandResult {
    const trans =
        effect.transitionMs ??
        (effect.type === 'fade' && effect.durationMs !== undefined
            ? effect.durationMs
            : DEFAULT_TRANSITION);
    const hold = effect.holdMs ?? 0;
    const color = effect.colors[0];
    const frames: Keyframe[] = [];
    const total = Math.max(100, effect.durationMs ?? 1500);
    const hi = effect.brightness ?? 100;
    const fadeFrom = effect.fadeFrom;

    switch (effect.type) {
        case 'loading': {
            // Lampe par lampe, chacune en UNE rampe depuis le noir ; la
            // suivante démarre juste avant la fin de la précédente (léger
            // chevauchement = fluide). Tout tient dans `durationMs`.
            const names = orderLights(lightNames, effect.order);
            const n = names.length;
            if (!n) return { frames, endMs: startMs + hold };
            const stagger = total / (n + 0.3);
            const ramp = Math.round(stagger * 1.3);
            names.forEach((name, i) => {
                frames.push({
                    atMs: startMs + Math.round(i * stagger),
                    lightName: name,
                    color,
                    brightness: hi,
                    fadeFrom: fadeFrom ?? 1,
                    transitionMs: ramp,
                });
            });
            return { frames, endMs: startMs + total + hold };
        }
        case 'wave': {
            // Balayage de la 1re couleur (60 % du temps) puis fondu de toutes
            // les lampes vers la 2e (40 %).
            const names = orderLights(lightNames, effect.order);
            const n = names.length;
            if (!n) return { frames, endMs: startMs + hold };
            const t1 = total * 0.6;
            const stagger = t1 / (n + 0.3);
            const ramp = Math.round(stagger * 1.3);
            names.forEach((name, i) => {
                frames.push({
                    atMs: startMs + Math.round(i * stagger),
                    lightName: name,
                    color,
                    brightness: hi,
                    ...(fadeFrom !== undefined ? { fadeFrom } : {}),
                    transitionMs: ramp,
                });
            });
            const second = effect.colors[1] ?? color;
            names.forEach((name) => {
                frames.push({
                    atMs: startMs + Math.round(t1),
                    lightName: name,
                    color: second,
                    brightness: hi,
                    transitionMs: Math.round(total - t1),
                });
            });
            return { frames, endMs: startMs + total + hold };
        }
        case 'blink': {
            // `count` éclats de toutes les lampes : plein puis sombre.
            const count = Math.max(1, Math.round(effect.count ?? 2));
            const period = total / count;
            const half = Math.round(period / 2);
            const lo = Math.max(1, Math.min(hi, 10));
            for (let k = 0; k < count; k++) {
                for (const name of lightNames) {
                    frames.push({
                        atMs: startMs + Math.round(k * period),
                        lightName: name,
                        color,
                        brightness: hi,
                        transitionMs: half,
                    });
                    frames.push({
                        atMs: startMs + Math.round(k * period) + half,
                        lightName: name,
                        color,
                        brightness: lo,
                        transitionMs: half,
                    });
                }
            }
            return { frames, endMs: startMs + total + hold };
        }
        case 'breathe': {
            // Une respiration : montée sur la moitié, descente sur l'autre.
            const half = Math.round(total / 2);
            const lo = Math.max(5, hi - 70);
            for (const name of lightNames) {
                frames.push({
                    atMs: startMs,
                    lightName: name,
                    color,
                    brightness: hi,
                    ...(fadeFrom !== undefined ? { fadeFrom } : {}),
                    transitionMs: half,
                });
                frames.push({
                    atMs: startMs + half,
                    lightName: name,
                    color,
                    brightness: lo,
                    transitionMs: half,
                });
            }
            return { frames, endMs: startMs + total + hold };
        }
        case 'sweep': {
            const stagger = effect.staggerMs ?? 0;
            lightNames.forEach((name, i) => {
                frames.push({
                    atMs: startMs + i * stagger,
                    lightName: name,
                    color,
                    brightness: effect.brightness,
                    ...(effect.fadeFrom !== undefined
                        ? { fadeFrom: effect.fadeFrom }
                        : {}),
                    transitionMs: trans,
                });
            });
            const lastStart =
                startMs + Math.max(0, lightNames.length - 1) * stagger;
            return { frames, endMs: lastStart + trans + hold };
        }
        case 'flash': {
            // Each colour applied to ALL lights simultaneously, cycling every `trans`.
            effect.colors.forEach((c, j) => {
                lightNames.forEach((name) => {
                    frames.push({
                        atMs: startMs + j * trans,
                        lightName: name,
                        color: c,
                        brightness: effect.brightness,
                        transitionMs: trans,
                    });
                });
            });
            return {
                frames,
                endMs: startMs + effect.colors.length * trans + hold,
            };
        }
        case 'pulse': {
            // Up then down on colours[0]; brightness defaults 100→20.
            const hi = effect.brightness ?? 100;
            const lo = Math.max(0, hi - 80);
            lightNames.forEach((name) => {
                frames.push({
                    atMs: startMs,
                    lightName: name,
                    color,
                    brightness: hi,
                    transitionMs: trans,
                });
                frames.push({
                    atMs: startMs + trans,
                    lightName: name,
                    color,
                    brightness: lo,
                    transitionMs: trans,
                });
            });
            return { frames, endMs: startMs + 2 * trans + hold };
        }
        case 'fade': {
            lightNames.forEach((name) => {
                frames.push({
                    atMs: startMs,
                    lightName: name,
                    color,
                    brightness: effect.brightness,
                    ...(effect.fadeFrom !== undefined
                        ? { fadeFrom: effect.fadeFrom }
                        : {}),
                    transitionMs: trans,
                });
            });
            return { frames, endMs: startMs + trans + hold };
        }
    }
    throw new Error(
        `type d'étape inconnu : ${String((effect as AnimationEffect).type)}`,
    );
}

/**
 * Expand a chain of effects into a single sorted timeline.
 * `startAtMs` (if set) places an effect at an absolute offset (enabling overlap);
 * otherwise it chains right after the previous effect's end.
 */
export function expandIntro(
    effects: AnimationEffect[],
    resolveLights: (target: string | string[]) => string[],
): { frames: Keyframe[]; totalMs: number } {
    let cursor = 0;
    const all: Keyframe[] = [];
    for (const effect of effects) {
        const start = effect.startAtMs ?? cursor;
        const lights = resolveLights(effect.target);
        const { frames, endMs } = expandEffect(effect, lights, start);
        all.push(...frames);
        cursor = Math.max(cursor, endMs);
    }
    all.sort((a, b) => a.atMs - b.atMs);
    return { frames: all, totalMs: cursor };
}
