import type { Scene, SceneAction } from './scenes';
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

// ── Animation auto (dérivée de la palette) ────────────────────────────────────

const INTRO_SPEED: Record<
    IntroSpeed,
    { staggerMs: number; transitionMs: number; holdMs: number }
> = {
    doux: { staggerMs: 180, transitionMs: 600, holdMs: 200 },
    normal: { staggerMs: 120, transitionMs: 350, holdMs: 100 },
    punchy: { staggerMs: 60, transitionMs: 150, holdMs: 0 },
};

export function buildAutoIntro(
    palette: string[],
    targets: string[],
    style: IntroStyle,
    speed: IntroSpeed,
): AnimationEffect[] {
    if (style === 'none' || palette.length === 0 || targets.length === 0)
        return [];
    const t = INTRO_SPEED[speed];
    const primary = targets[0];
    const effects: AnimationEffect[] = [];
    let at = 0;
    for (const color of palette) {
        effects.push({
            type: style,
            target: primary,
            colors: [color],
            startAtMs: at,
            staggerMs: t.staggerMs,
            transitionMs: t.transitionMs,
            holdMs: t.holdMs,
        });
        at += t.transitionMs + t.holdMs;
    }
    return effects;
}

export function buildAutoFloating(
    palette: string[],
    target: string,
    brightness?: number,
): FloatingConfig {
    // FloatingConfig exige 2+ couleurs : duplique si une seule.
    const pal = palette.length >= 2 ? palette : [...palette, ...palette];
    const cfg: FloatingConfig = {
        engine: 'software',
        target,
        palette: pal,
        speedSec: 60,
        staggerSec: 6,
        speedJitter: 0.15,
    };
    if (brightness !== undefined) cfg.brightness = brightness;
    return cfg;
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
    const state = compileState(spec);

    const onLights = spec.lights.filter(
        (
            l,
        ): l is {
            target: string;
            on: true;
            brightness?: number;
            color?: string;
        } => l.on === true,
    );
    const palette = [
        ...new Set(
            onLights.map((l) => l.color).filter((c): c is string => !!c),
        ),
    ];
    const targets = onLights.map((l) => l.target);
    const primaryTarget = targets[0] ?? 'Salon';
    const brightnesses = onLights
        .map((l) => l.brightness)
        .filter((b): b is number => b !== undefined);
    const avgBrightness =
        brightnesses.length > 0
            ? Math.round(
                  brightnesses.reduce((a, b) => a + b, 0) / brightnesses.length,
              )
            : undefined;

    const result: CompiledScene = { state };

    const introStyle = spec.ambiance?.intro?.style ?? 'none';
    if (introStyle !== 'none' && palette.length > 0) {
        result.intro = buildAutoIntro(
            palette,
            targets,
            introStyle,
            spec.ambiance!.intro!.speed,
        );
    }

    if (spec.ambiance?.motion && palette.length > 0) {
        result.floating = buildAutoFloating(
            palette,
            primaryTarget,
            avgBrightness,
        );
    }

    return result;
}

// ── Détection & parsing inverse ───────────────────────────────────────────────

const REPRESENTABLE_TOOLS = new Set([
    '_lights_all_off',
    'set_lights',
    'pause_music',
    'play_music',
    'lock_door',
    'unlock_door',
    '_covers_all',
    '_close_covers_if_daylight',
]);

function hasFn(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    if ('$fn' in (value as object)) return true;
    return Object.values(value as Record<string, unknown>).some(hasFn);
}

export function isSimpleRepresentable(
    scene: Pick<Scene, 'setup' | 'state'>,
): boolean {
    if (scene.setup && scene.setup.length > 0) return false;
    return scene.state.every((a) => {
        if (!REPRESENTABLE_TOOLS.has(a.tool)) return false;
        if (a.condition) return false;
        if (hasFn(a.args)) return false;
        return true;
    });
}

export function parseToSimpleSpec(
    scene: Pick<Scene, 'setup' | 'state' | 'intro' | 'floating'>,
): SimpleSceneSpec | null {
    if (!isSimpleRepresentable(scene)) return null;

    const spec: SimpleSceneSpec = { lights: [] };

    for (const a of scene.state) {
        switch (a.tool) {
            case '_lights_all_off':
                spec.allOff = true;
                break;
            case 'set_lights': {
                const args = a.args as {
                    target: string;
                    on?: boolean;
                    brightness?: number;
                    color?: string;
                };
                if (args.on === false) {
                    spec.lights.push({ target: args.target, on: false });
                } else {
                    const light: SimpleLightTarget = {
                        target: args.target,
                        on: true,
                    };
                    if (args.brightness !== undefined)
                        light.brightness = args.brightness;
                    if (args.color !== undefined) light.color = args.color;
                    spec.lights.push(light);
                }
                break;
            }
            case 'pause_music':
                spec.music = { action: 'off' };
                break;
            case 'play_music': {
                const args = a.args as { speakerName?: string; query?: string };
                spec.music = { action: 'play' };
                if (args.query) spec.music.query = args.query;
                if (args.speakerName) spec.music.speaker = args.speakerName;
                break;
            }
            case 'lock_door':
                spec.door = { action: 'lock' };
                break;
            case 'unlock_door':
                spec.door = { action: 'unlock' };
                break;
            case '_covers_all': {
                const args = a.args as {
                    action?: 'open' | 'close';
                    position?: number;
                    daylightOnly?: boolean;
                };
                spec.covers = { action: args.action ?? 'close' };
                if (args.position !== undefined)
                    spec.covers.position = args.position;
                if (args.daylightOnly !== undefined)
                    spec.covers.daylightOnly = args.daylightOnly;
                break;
            }
            case '_close_covers_if_daylight': {
                const args = a.args as { position?: number };
                spec.covers = { action: 'close', daylightOnly: true };
                if (args.position !== undefined)
                    spec.covers.position = args.position;
                break;
            }
        }
    }

    // Ambiance best-effort : style depuis le 1er effet, motion si floating présent.
    if (scene.intro?.length) {
        const style = scene.intro[0].type;
        if (style === 'sweep' || style === 'pulse' || style === 'fade') {
            spec.ambiance = {
                ...(spec.ambiance ?? {}),
                intro: { style, speed: 'normal' },
            };
        }
    }
    if (scene.floating) {
        spec.ambiance = { ...(spec.ambiance ?? {}), motion: true };
    }

    return spec;
}
