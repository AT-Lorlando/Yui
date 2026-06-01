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
export function expandEffect(
    effect: AnimationEffect,
    lightNames: string[],
    startMs: number,
): ExpandResult {
    const trans = effect.transitionMs ?? DEFAULT_TRANSITION;
    const hold = effect.holdMs ?? 0;
    const color = effect.colors[0];
    const frames: Keyframe[] = [];

    switch (effect.type) {
        case 'sweep': {
            const stagger = effect.staggerMs ?? 0;
            lightNames.forEach((name, i) => {
                frames.push({
                    atMs: startMs + i * stagger,
                    lightName: name,
                    color,
                    brightness: effect.brightness,
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
                    transitionMs: trans,
                });
            });
            return { frames, endMs: startMs + trans + hold };
        }
    }
}

/**
 * Expand a chain of effects into a single sorted timeline.
 * `startAtMs` (if set) places an effect at an absolute offset (enabling overlap);
 * otherwise it chains right after the previous effect's end.
 */
export function expandIntro(
    effects: AnimationEffect[],
    resolveLights: (target: string) => string[],
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
