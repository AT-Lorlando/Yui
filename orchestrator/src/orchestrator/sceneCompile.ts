import type { SceneAction } from './scenes';
import type { AnimationEffect, FloatingConfig } from './animation/types';

// ── Types ───────────────────────────────────────────────────────────────────

export type SimpleLightTarget =
    | { target: string; on: false }
    | { target: string; on: true; brightness?: number; color?: string };

export type IntroStyle = 'none' | 'sweep' | 'pulse' | 'fade';
export type IntroSpeed = 'doux' | 'normal' | 'punchy';

export interface SimpleSceneSpec {
    /** Démarre par un "tout éteindre". */
    allOff?: boolean;
    /** État cible par pièce ou lampe nommée. */
    lights: SimpleLightTarget[];
    music?:
        | { action: 'off' }
        | { action: 'play'; query?: string; speaker?: string };
    covers?: {
        action: 'none' | 'close' | 'open';
        position?: number;
        daylightOnly?: boolean;
    };
    door?: { action: 'none' | 'lock' | 'unlock' };
    ambiance?: {
        intro?: { style: IntroStyle; speed: IntroSpeed };
        /** Couleurs flottantes continues, dérivées de la palette. */
        motion?: boolean;
    };
}

export interface CompiledScene {
    state: SceneAction[];
    intro?: AnimationEffect[];
    floating?: FloatingConfig;
}

// ── Compilation de l'état ─────────────────────────────────────────────────────

function compileState(spec: SimpleSceneSpec): SceneAction[] {
    const state: SceneAction[] = [];

    if (spec.allOff) {
        state.push({ tool: '_lights_all_off', args: {} });
    }

    for (const light of spec.lights) {
        if (light.on === false) {
            state.push({
                tool: 'set_lights',
                args: { target: light.target, on: false },
            });
        } else {
            const args: Record<string, unknown> = {
                target: light.target,
                on: true,
            };
            if (light.brightness !== undefined)
                args.brightness = light.brightness;
            if (light.color !== undefined) args.color = light.color;
            state.push({ tool: 'set_lights', args });
        }
    }

    if (spec.music) {
        if (spec.music.action === 'off') {
            state.push({ tool: 'pause_music', args: {} });
        } else {
            const args: Record<string, unknown> = {
                speakerName: spec.music.speaker ?? 'Salon',
            };
            if (spec.music.query) args.query = spec.music.query;
            state.push({ tool: 'play_music', args });
        }
    }

    if (spec.covers && spec.covers.action !== 'none') {
        const args: Record<string, unknown> = { action: spec.covers.action };
        if (spec.covers.position !== undefined)
            args.position = spec.covers.position;
        if (spec.covers.daylightOnly !== undefined)
            args.daylightOnly = spec.covers.daylightOnly;
        state.push({ tool: '_covers_all', args });
    }

    if (spec.door && spec.door.action !== 'none') {
        state.push({
            tool: spec.door.action === 'lock' ? 'lock_door' : 'unlock_door',
            args: {},
        });
    }

    return state;
}

export function compileSimpleScene(spec: SimpleSceneSpec): CompiledScene {
    return { state: compileState(spec) };
}
