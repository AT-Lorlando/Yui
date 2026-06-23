import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Logger from '../logger';
import { dataPath } from '@yui/shared';
import type { PresenceState } from './presence';
import type { AnimationEffect, FloatingConfig } from './animation/types';
import { animationManager } from './animation/animationManager';
import { compileIfSimple, type SimpleSceneSpec } from './sceneCompile';

// ── Scene conditions ───────────────────────────────────────────────────────────

/**
 * Conditions evaluated at runtime before executing a SceneAction.
 * If the condition is false, the action is skipped (not an error).
 *
 * Examples:
 *   { "hourBetween": [6, 22] }          → true if 6h ≤ now < 22h
 *   { "presence": "home" }              → true if user is home
 *   { "and": [...] }                    → all sub-conditions true
 *   { "or": [...] }                     → at least one true
 *   { "not": { "presence": "away" } }   → negation
 */
export type SceneCondition =
    | { hourBetween: [number, number] }
    | { presence: PresenceState }
    | { and: SceneCondition[] }
    | { or: SceneCondition[] }
    | { not: SceneCondition };

// ── Dynamic arg values ($fn) ───────────────────────────────────────────────────

/**
 * A dynamic value resolved at runtime from built-in functions.
 * Use in any arg value: { "$fn": "time_brightness" }
 *
 * Built-in functions:
 *   time_brightness  → 0–100 brightness based on current hour
 *   hour             → current hour (0–23)
 *   minute           → current minute (0–59)
 *   day_of_week      → 0 (Sunday) … 6 (Saturday)
 *   is_weekend       → 1 if Saturday/Sunday, 0 otherwise
 *   season           → "spring" | "summer" | "autumn" | "winter"
 *   random           → integer in [$min, $max] (defaults: 0–100)
 */
export type SceneFnRef =
    | {
          $fn:
              | 'time_brightness'
              | 'hour'
              | 'minute'
              | 'day_of_week'
              | 'is_weekend'
              | 'season';
      }
    | { $fn: 'random'; $min?: number; $max?: number };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SceneAction {
    /**
     * MCP tool name (e.g. "turn_on_light") or a virtual action prefixed with _:
     *   _lights_all_on          { brightness?: number }
     *   _lights_all_off
     *   _lights_all_brightness  { brightness: number }
     *   _lights_all_color       { color: string (hex), brightness?: number }
     *   _lights_palette         { colors: string[], brightness?: number }
     *     → applies set_room_palette per room with the given colors
     *   _doors_lock_all
     *   _notify                 { message: string }
     *   _run_scene              { id: string }
     *   _random_scene           { ids: string[] }
     */
    tool: string;
    args: Record<string, unknown>;
    /** Milliseconds to wait BEFORE this action */
    delayMs?: number;
    /**
     * Optional condition evaluated at runtime.
     * If false, the action is skipped entirely.
     */
    condition?: SceneCondition;
}

export interface Scene {
    id: string;
    name: string;
    /** lucide icon name */
    icon: string;
    /** Hex accent colour for the UI card */
    color: string;
    description: string;
    /**
     * Setup actions: preparatory infrastructure run first (e.g. TV power on,
     * switch input). These must complete before state actions begin.
     */
    setup: SceneAction[];
    /**
     * State actions: the scene's actual content (lights, music, video, etc.).
     * Run after setup completes.
     */
    state: SceneAction[];
    createdAt: number;
    /** Built-in scenes cannot be deleted */
    builtIn?: boolean;
    /** Marked as favorite by the user — pinned in the dashboard */
    favorite?: boolean;
    /** Free-text category for grouping in the UI (e.g. "Cinéma", "Ambiance", "Routines"). Defaults to "Scènes". */
    label?: string;
    /** Optional intro animation played before the final state. */
    intro?: AnimationEffect[];
    /** Optional continuous floating-colour config started after the state. */
    floating?: FloatingConfig;
    /** Quel éditeur ouvrir : 'simple' (déclaratif) ou 'advanced' (liste d'actions). */
    authoring?: 'simple' | 'advanced';
    /** Spec déclarative — source de vérité quand authoring === 'simple'. */
    simple?: SimpleSceneSpec;
}

export type CreateSceneInput = Omit<Scene, 'id' | 'createdAt' | 'builtIn'>;

// ── Storage ───────────────────────────────────────────────────────────────────

const SCENES_FILE = dataPath('scenes.json');

function ensureDataDir(): void {
    const dir = path.dirname(SCENES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadScenes(): Scene[] {
    try {
        if (!fs.existsSync(SCENES_FILE)) return [];
        return JSON.parse(fs.readFileSync(SCENES_FILE, 'utf-8')) as Scene[];
    } catch {
        return [];
    }
}

function saveScenes(scenes: Scene[]): void {
    ensureDataDir();
    fs.writeFileSync(SCENES_FILE, JSON.stringify(scenes, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function listScenes(): Scene[] {
    return loadScenes();
}

export function getScene(id: string): Scene | null {
    return listScenes().find((s) => s.id === id) ?? null;
}

export function createScene(data: CreateSceneInput): Scene {
    const compiled = compileIfSimple(data);
    const scene: Scene = {
        ...compiled,
        id: crypto.randomUUID().slice(0, 8),
        createdAt: Date.now(),
        builtIn: false,
    };
    const scenes = loadScenes();
    scenes.push(scene);
    saveScenes(scenes);
    Logger.info(`Scene created: "${scene.name}" (${scene.id})`);
    return scene;
}

export function deleteScene(id: string): boolean {
    const scene = getScene(id);
    if (!scene) return false;
    if (scene.builtIn) {
        Logger.warn(`Cannot delete built-in scene "${id}"`);
        return false;
    }
    const scenes = loadScenes().filter((s) => s.id !== id);
    saveScenes(scenes);
    return true;
}

export function updateScene(
    id: string,
    input: Partial<CreateSceneInput>,
): Scene | null {
    const scenes = loadScenes();
    const idx = scenes.findIndex((s) => s.id === id);
    if (idx === -1 || scenes[idx].builtIn) return null;
    scenes[idx] = compileIfSimple({ ...scenes[idx], ...input });
    saveScenes(scenes);
    Logger.info(`Scene updated: "${scenes[idx].name}" (${id})`);
    return scenes[idx];
}

export function toggleFavorite(id: string): Scene | null {
    const scenes = loadScenes();
    const scene = scenes.find((s) => s.id === id);
    if (!scene) return null;
    scene.favorite = !scene.favorite;
    saveScenes(scenes);
    Logger.info(`Scene "${scene.name}" (${id}) favorite: ${scene.favorite}`);
    return scene;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export type CallTool = (
    tool: string,
    args: Record<string, unknown>,
) => Promise<unknown>;

type NotifyFn = (message: string) => Promise<void>;

export interface SceneContext {
    presenceState?: PresenceState;
    notify?: NotifyFn;
    /** Guard-free tool path for animation loops (avoids self-cancel). */
    callToolRaw?: CallTool;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Condition evaluation ───────────────────────────────────────────────────────

function evaluateCondition(
    condition: SceneCondition,
    context: SceneContext,
): boolean {
    const now = new Date();
    const hour = now.getHours();

    if ('hourBetween' in condition) {
        const [from, to] = condition.hourBetween;
        return from <= to
            ? hour >= from && hour < to
            : hour >= from || hour < to;
    }
    if ('presence' in condition) {
        return context.presenceState === condition.presence;
    }
    if ('and' in condition) {
        return condition.and.every((c) => evaluateCondition(c, context));
    }
    if ('or' in condition) {
        return condition.or.some((c) => evaluateCondition(c, context));
    }
    if ('not' in condition) {
        return !evaluateCondition(condition.not, context);
    }
    return true;
}

// ── $fn resolution ────────────────────────────────────────────────────────────

/**
 * Brightness curve based on time of day:
 *   00–06 → 5%   (nuit)
 *   06–09 → 40%  (matin)
 *   09–18 → 80%  (jour)
 *   18–21 → 50%  (soir)
 *   21–24 → 20%  (nuit)
 */
function timeBrightness(hour: number): number {
    if (hour < 6) return 5;
    if (hour < 9) return 40;
    if (hour < 18) return 80;
    if (hour < 21) return 50;
    return 20;
}

function season(month: number): string {
    if (month < 3 || month === 11) return 'winter';
    if (month < 6) return 'spring';
    if (month < 9) return 'summer';
    return 'autumn';
}

function resolveArgValue(value: unknown): unknown {
    if (
        value !== null &&
        typeof value === 'object' &&
        '$fn' in (value as object)
    ) {
        const ref = value as SceneFnRef;
        const now = new Date();
        switch (ref.$fn) {
            case 'time_brightness':
                return timeBrightness(now.getHours());
            case 'hour':
                return now.getHours();
            case 'minute':
                return now.getMinutes();
            case 'day_of_week':
                return now.getDay();
            case 'is_weekend':
                return now.getDay() === 0 || now.getDay() === 6 ? 1 : 0;
            case 'season':
                return season(now.getMonth());
            case 'random': {
                const min = ('$min' in ref ? ref.$min : undefined) ?? 0;
                const max = ('$max' in ref ? ref.$max : undefined) ?? 100;
                return Math.floor(Math.random() * (max - min + 1)) + min;
            }
            default:
                Logger.warn(`Unknown $fn: "${(ref as { $fn: string }).$fn}"`);
                return value;
        }
    }
    return value;
}

function resolveArgs(args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(args).map(([k, v]) => [k, resolveArgValue(v)]),
    );
}

// ── Virtual actions ────────────────────────────────────────────────────────────

export function isVirtualSceneTool(name: string): boolean {
    return name.startsWith('_');
}

export async function runVirtualAction(
    action: SceneAction,
    callTool: CallTool,
    context: SceneContext,
): Promise<void> {
    switch (action.tool) {
        case '_lights_all_on':
            await callTool('turn_on_all_lights', {
                ...(action.args.brightness !== undefined
                    ? { brightness: action.args.brightness }
                    : {}),
            });
            break;

        case '_lights_all_off':
            await callTool('turn_off_all_lights', {});
            break;

        case '_lights_all_brightness':
            await callTool('turn_on_all_lights', {
                brightness: action.args.brightness,
            });
            break;

        case '_lights_all_color': {
            // set_lights accepts a room name — use 'Appartement' to hit all rooms
            await callTool('set_lights', {
                target: 'Appartement',
                on: true,
                color: action.args.color,
                ...(action.args.brightness !== undefined
                    ? { brightness: action.args.brightness }
                    : {}),
            });
            break;
        }

        case '_lights_palette': {
            // Group lights by room, apply set_room_palette per room
            const lights = (await callTool('list_lights', {})) as {
                id: number;
                name: string;
                room: string;
            }[];
            const colors = action.args.colors as string[];
            const rooms = [
                ...new Set(lights.map((l) => l.room).filter(Boolean)),
            ];
            await Promise.allSettled(
                rooms.map((room) =>
                    callTool('set_room_palette', {
                        room,
                        colors,
                        ...(action.args.brightness !== undefined
                            ? { brightness: action.args.brightness }
                            : {}),
                    }),
                ),
            );
            break;
        }

        case '_close_covers_if_daylight': {
            // Closes all Somfy covers to a given position (default 80) iff it's
            // daylight (07h–21h local time). Skip silently at night.
            const hour = new Date().getHours();
            if (hour < 7 || hour >= 21) {
                Logger.debug(
                    'Scene _close_covers_if_daylight: night — skipping',
                );
                break;
            }
            const position =
                typeof action.args.position === 'number'
                    ? action.args.position
                    : 80;
            const covers = (await callTool('list_covers', {})) as any[];
            await Promise.allSettled(
                (covers ?? []).map((c) =>
                    callTool('set_cover_position', {
                        device: c.name ?? c.label ?? c.url,
                        position,
                    }),
                ),
            );
            break;
        }

        case '_covers_all': {
            // Ouvre/ferme tous les volets Somfy. position: 0 = ouvert, 100 = fermé.
            // daylightOnly: ne rien faire la nuit (avant 7h / après 21h).
            if (action.args.daylightOnly === true) {
                const hour = new Date().getHours();
                if (hour < 7 || hour >= 21) {
                    Logger.debug('Scene _covers_all: night — skipping');
                    break;
                }
            }
            const closing = action.args.action === 'close';
            const position =
                typeof action.args.position === 'number'
                    ? action.args.position
                    : closing
                    ? 80
                    : 0;
            const covers = (await callTool('list_covers', {})) as any[];
            await Promise.allSettled(
                (covers ?? []).map((c) =>
                    callTool('set_cover_position', {
                        device: c.name ?? c.label ?? c.url,
                        position,
                    }),
                ),
            );
            break;
        }

        case '_doors_lock_all': {
            await callTool('lock_door', {});
            break;
        }

        case '_house_off': {
            // "Tout éteindre" unifié — lumières + Govee ambiance + TV + cast +
            // musique + ampli. Tous en parallèle, échecs silencieux pour ne pas
            // bloquer si un device est offline.
            await Promise.allSettled([
                callTool('turn_off_all_lights', {}),
                callTool('tv_off', {}),
                callTool('cast_stop', {}),
                callTool('stop_music', {}),
                callTool('amp_off', {}),
            ]);
            break;
        }

        case '_notify': {
            const message = action.args.message as string;
            if (context.notify) {
                await context.notify(message);
            } else {
                Logger.warn(`Scene _notify: no notify function in context`);
            }
            break;
        }

        case '_run_scene': {
            const id = action.args.id as string;
            await runSceneInternal(id, callTool, context);
            break;
        }

        case '_random_scene': {
            const ids = action.args.ids as string[];
            if (!ids?.length) {
                Logger.warn('Scene _random_scene: empty ids list');
                break;
            }
            const picked = ids[Math.floor(Math.random() * ids.length)];
            Logger.info(
                `Scene _random_scene: picked "${picked}" from [${ids.join(
                    ', ',
                )}]`,
            );
            await runSceneInternal(picked, callTool, context);
            break;
        }

        default:
            Logger.warn(`Unknown virtual scene action: "${action.tool}"`);
    }
}

async function runActions(
    phase: 'setup' | 'state',
    actions: SceneAction[],
    sceneName: string,
    callTool: CallTool,
    context: SceneContext,
): Promise<void> {
    for (const action of actions) {
        // Evaluate condition — skip action if false
        if (action.condition) {
            const pass = evaluateCondition(action.condition, context);
            if (!pass) {
                Logger.debug(
                    `Scene "${sceneName}" [${phase}]: skipped ${action.tool} (condition false)`,
                );
                continue;
            }
        }

        if (action.delayMs) {
            Logger.debug(
                `Scene "${sceneName}" [${phase}]: waiting ${action.delayMs}ms`,
            );
            await sleep(action.delayMs);
        }

        // Resolve $fn values in args
        const resolvedArgs = resolveArgs(action.args);

        try {
            if (action.tool.startsWith('_')) {
                await runVirtualAction(
                    { ...action, args: resolvedArgs },
                    callTool,
                    context,
                );
            } else {
                await callTool(action.tool, resolvedArgs);
            }
            Logger.debug(`Scene "${sceneName}" [${phase}]: ✓ ${action.tool}`);
        } catch (err) {
            Logger.warn(
                `Scene "${sceneName}" [${phase}]: action "${action.tool}" failed — ${err}`,
            );
            // Non-fatal: keep running remaining actions
        }
    }
}

/**
 * Exécute une liste d'actions de scène hors d'une scène (pour le moteur de règles
 * présence, bindings, etc.). Réutilise le runner interne : conditions + delays +
 * dispatch virtuel/MCP, non-fatal par action.
 */
export async function runActionList(
    actions: SceneAction[],
    label: string,
    callTool: CallTool,
    context: SceneContext = {},
): Promise<void> {
    await runActions('state', actions, label, callTool, context);
}

async function runSceneInternal(
    sceneId: string,
    callTool: CallTool,
    context: SceneContext,
): Promise<{ success: boolean; error?: string }> {
    const scene = getScene(sceneId);
    if (!scene)
        return { success: false, error: `Scene "${sceneId}" not found` };

    const animCall = context.callToolRaw ?? callTool;

    Logger.info(
        `Running scene "${scene.name}" ` +
            `(setup: ${scene.setup.length}, state: ${scene.state.length}` +
            `${scene.intro ? `, intro: ${scene.intro.length}` : ''}` +
            `${scene.floating ? ', floating' : ''})`,
    );

    // Any new scene cancels a running floating loop before it begins.
    await animationManager.stopAll();

    // Intro plays on the lights WHILE setup (TV/cast prep) runs — hides latency.
    const introP = scene.intro?.length
        ? animationManager.playIntro(scene.intro, animCall)
        : Promise.resolve();
    const setupP = runActions(
        'setup',
        scene.setup,
        scene.name,
        callTool,
        context,
    );
    await Promise.all([introP, setupP]);

    await runActions('state', scene.state, scene.name, callTool, context);

    if (scene.floating) {
        await animationManager.startFloating(scene.floating, animCall);
    }

    Logger.info(`Scene "${scene.name}" complete`);
    return { success: true };
}

export async function runScene(
    sceneId: string,
    callTool: CallTool,
    context: SceneContext = {},
): Promise<{ success: boolean; error?: string }> {
    return runSceneInternal(sceneId, callTool, context);
}
