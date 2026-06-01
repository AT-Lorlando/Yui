// orchestrator/src/orchestrator/animation/types.ts

/** A single parameterized effect that generates keyframes. */
export interface AnimationEffect {
    type: 'sweep' | 'flash' | 'pulse' | 'fade';
    /** Room name ("Salon") or individual light name. */
    target: string;
    /** 1+ hex colours, e.g. ["#00FF00"]. */
    colors: string[];
    /** Absolute offset (ms) from anim start. If omitted, chains after the previous effect. */
    startAtMs?: number;
    /** Per-light delay (ms) for `sweep`. Default 0. */
    staggerMs?: number;
    /** Hue fade duration (ms) per light. Default 400. */
    transitionMs?: number;
    /** 0–100. */
    brightness?: number;
    /** Hold (ms) added after the effect before the next chains. Default 0. */
    holdMs?: number;
}

/** A resolved, concrete light command at an absolute time. */
export interface Keyframe {
    /** Absolute ms from anim start. */
    atMs: number;
    /** Concrete light name (resolved from the effect target). */
    lightName: string;
    color?: string;
    brightness?: number;
    transitionMs: number;
}

/** Continuous floating-colour config attached to a scene. */
export interface FloatingConfig {
    engine: 'software' | 'native';
    /** Room name or individual light name. */
    target: string;
    /** Global gradient, 2+ hex colours. */
    palette: string[];
    /** Duration (s) of one full palette cycle. */
    speedSec: number;
    /** Phase offset (s) between consecutive lights. Default 0. */
    staggerSec?: number;
    /** 0–1: per-light speed variation. Default 0. */
    speedJitter?: number;
    brightness?: number;
    /** Per-light overrides keyed by light name. */
    perLight?: Record<string, { palette?: string[]; speedSec?: number }>;
}
