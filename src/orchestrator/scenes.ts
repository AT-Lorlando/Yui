import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Logger from '../logger';

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
     */
    tool: string;
    args: Record<string, unknown>;
    /** Milliseconds to wait BEFORE this action */
    delayMs?: number;
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
}

export type CreateSceneInput = Omit<Scene, 'id' | 'createdAt' | 'builtIn'>;

// ── Storage ───────────────────────────────────────────────────────────────────

const SCENES_FILE = path.resolve(process.cwd(), 'data/scenes.json');

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
    const scene: Scene = {
        ...data,
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

// ── Runner ────────────────────────────────────────────────────────────────────

type CallTool = (
    tool: string,
    args: Record<string, unknown>,
) => Promise<unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runVirtualAction(
    action: SceneAction,
    callTool: CallTool,
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

        case '_doors_lock_all': {
            const doors = (await callTool('list_doors', {})) as {
                nukiId: number;
            }[];
            await Promise.allSettled(
                doors.map((d) => callTool('lock_door', { nukiId: d.nukiId })),
            );
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
): Promise<void> {
    for (const action of actions) {
        if (action.delayMs) {
            Logger.debug(
                `Scene "${sceneName}" [${phase}]: waiting ${action.delayMs}ms`,
            );
            await sleep(action.delayMs);
        }
        try {
            if (action.tool.startsWith('_')) {
                await runVirtualAction(action, callTool);
            } else {
                await callTool(action.tool, action.args);
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

export async function runScene(
    sceneId: string,
    callTool: CallTool,
): Promise<{ success: boolean; error?: string }> {
    const scene = getScene(sceneId);
    if (!scene)
        return { success: false, error: `Scene "${sceneId}" not found` };

    Logger.info(
        `Running scene "${scene.name}" ` +
            `(setup: ${scene.setup.length}, state: ${scene.state.length})`,
    );

    // Run setup phase first (infrastructure: TV, inputs, etc.)
    await runActions('setup', scene.setup, scene.name, callTool);

    // Then run state phase (lights, music, video, etc.)
    await runActions('state', scene.state, scene.name, callTool);

    Logger.info(`Scene "${scene.name}" complete`);
    return { success: true };
}
