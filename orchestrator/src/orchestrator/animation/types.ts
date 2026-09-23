// orchestrator/src/orchestrator/animation/types.ts

/**
 * Types d'étape d'intro.
 *  - bruts (sweep/flash/pulse/fade) : paramètres bridge (décalage, transition) ;
 *  - gabarits (loading/wave/blink/breathe) : une DURÉE TOTALE, répartie à
 *    l'expansion sur le nombre réel de lampes — « 1,5 s max » tient quel que
 *    soit le nombre de lampes de la pièce.
 */
export type EffectStepType =
    | 'sweep'
    | 'flash'
    | 'pulse'
    | 'fade'
    | 'loading'
    | 'wave'
    | 'blink'
    | 'breathe';

/** A single parameterized effect that generates keyframes. */
export interface AnimationEffect {
    type: EffectStepType;
    /** Room name ("Salon"), light name, or a list of rooms/lights. */
    target: string | string[];
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
    /** Luminosité de DÉPART du fondu (sweep/fade/gabarits) : ON instantané à
     *  cette valeur avec la couleur, puis montée vers `brightness`. */
    fadeFrom?: number;
    /** Hold (ms) added after the effect before the next chains. Default 0. */
    holdMs?: number;
    /** Gabarits : durée totale du step (ms). Défaut 1500. */
    durationMs?: number;
    /** loading/wave : ordre de parcours des lampes. Défaut forward. */
    order?: 'forward' | 'reverse' | 'random';
    /** blink : nombre d'éclats. Défaut 2. */
    count?: number;
}

/** A resolved, concrete light command at an absolute time. */
export interface Keyframe {
    /** Absolute ms from anim start. */
    atMs: number;
    /** Concrete light name (resolved from the effect target). */
    lightName: string;
    color?: string;
    brightness?: number;
    fadeFrom?: number;
    transitionMs: number;
}

/** Continuous floating-colour config attached to a scene. */
export interface FloatingConfig {
    engine: 'software' | 'native';
    /** Room name, individual light name, or a LIST of rooms/lights (union). */
    target: string | string[];
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
