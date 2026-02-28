import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Logger from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SceneAction {
    /**
     * MCP tool name (e.g. "turn_on_light") or a virtual action prefixed with _:
     *   _lights_all_on / _lights_all_off
     *   _lights_all_brightness  { brightness: number }
     *   _lights_all_color       { color: string (hex) }
     *   _lights_palette         { colors: string[], brightness: number }
     *     → distributes colors across lights (light 0 → colors[0], light 1 → colors[1], wraps)
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
    actions: SceneAction[];
    createdAt: number;
    /** Built-in scenes cannot be deleted */
    builtIn?: boolean;
}

export type CreateSceneInput = Omit<Scene, 'id' | 'createdAt' | 'builtIn'>;

// ── Built-in scenes ───────────────────────────────────────────────────────────

const BUILTIN_SCENES: Scene[] = [
    {
        // Cinema-grade darkness: deep blood red anchor light, near-black everywhere else
        id: 'netflix',
        name: 'Cinéma',
        icon: 'lucide:clapperboard',
        color: '#C0392B',
        description: 'Netflix sur grand écran, obscurité rouge sang',
        builtIn: true,
        createdAt: 0,
        actions: [
            { tool: 'tv_prepare_chromecast', args: {} },
            {
                tool: 'tv_launch_app',
                args: { appId: '11101200001', appName: 'Netflix' },
                delayMs: 3000,
            },
            { tool: 'pause_music', args: {} },
            // Deep red accent on first light, near-black on the rest
            {
                tool: '_lights_palette',
                args: {
                    colors: ['#6B0000', '#1A0000', '#0D0000'],
                    brightness: 8,
                },
            },
        ],
    },
    {
        // Aurora borealis: icy cyan → emerald → deep violet, shifting across the room
        id: 'aurora',
        name: 'Aurores boréales',
        icon: 'lucide:sparkles',
        color: '#06B6D4',
        description:
            'Cyan glacé, vert arctique, violet profond — musique ambiante',
        builtIn: true,
        createdAt: 0,
        actions: [
            { tool: '_lights_all_on', args: {} },
            {
                tool: '_lights_palette',
                args: {
                    colors: [
                        '#00FFCC',
                        '#0088FF',
                        '#7B00FF',
                        '#00C8A0',
                        '#003CFF',
                    ],
                    brightness: 40,
                },
            },
            {
                tool: 'play_music',
                args: {
                    speakerName: 'Salon',
                    query: 'aurora borealis ambient iceland',
                },
            },
        ],
    },
    {
        // Golden hour: the 20 minutes before sunset — amber, coral, and soft violet in the shadows
        id: 'golden_hour',
        name: 'Heure dorée',
        icon: 'lucide:sunset',
        color: '#F97316',
        description: 'Ambre chaud, corail et violet crépusculaire',
        builtIn: true,
        createdAt: 0,
        actions: [
            { tool: '_lights_all_on', args: {} },
            {
                tool: '_lights_palette',
                args: {
                    colors: [
                        '#FF8C00',
                        '#FF4500',
                        '#FFD700',
                        '#C2440C',
                        '#6B21A8',
                    ],
                    brightness: 55,
                },
            },
            {
                tool: 'play_music',
                args: {
                    speakerName: 'Salon',
                    query: 'lofi jazz sunset afternoon',
                },
            },
        ],
    },
    {
        // Campfire: deep ember orange core, fading to dark crimson edges — intimate warmth
        id: 'campfire',
        name: 'Feu de camp',
        icon: 'lucide:flame',
        color: '#EA580C',
        description: 'Braise orange, rouge brûlé — sons de nature et feu',
        builtIn: true,
        createdAt: 0,
        actions: [
            { tool: '_lights_all_on', args: {} },
            {
                tool: '_lights_palette',
                args: {
                    colors: [
                        '#FF6B35',
                        '#CC3300',
                        '#8B1A00',
                        '#FF9000',
                        '#3D0C00',
                    ],
                    brightness: 35,
                },
            },
            {
                tool: 'play_music',
                args: {
                    speakerName: 'Salon',
                    query: 'crackling campfire nature ambient rain',
                },
            },
        ],
    },
    {
        // Deep ocean: bioluminescent blues — like being 200m underwater at night
        id: 'deep_ocean',
        name: 'Fond marin',
        icon: 'lucide:waves',
        color: '#0EA5E9',
        description: 'Bleu abyssal, bioluminescence, sons sous-marins',
        builtIn: true,
        createdAt: 0,
        actions: [
            { tool: '_lights_all_on', args: {} },
            {
                tool: '_lights_palette',
                args: {
                    colors: [
                        '#001B6B',
                        '#003B8F',
                        '#0077B6',
                        '#00B4D8',
                        '#023E8A',
                    ],
                    brightness: 30,
                },
            },
            {
                tool: 'play_music',
                args: {
                    speakerName: 'Salon',
                    query: 'deep ocean underwater ambient meditation',
                },
            },
        ],
    },
    {
        // Romantic: low rose-gold + candlelight amber — exactly two colors, no more
        id: 'romantic',
        name: 'Romantique',
        icon: 'lucide:heart',
        color: '#E11D48',
        description: 'Rose-gold et ambre bougie — jazz intimiste',
        builtIn: true,
        createdAt: 0,
        actions: [
            { tool: '_lights_all_on', args: {} },
            {
                tool: '_lights_palette',
                args: {
                    colors: ['#8B0038', '#CC2B52', '#FF6B6B', '#B8621A'],
                    brightness: 22,
                },
            },
            {
                tool: 'play_music',
                args: {
                    speakerName: 'Salon',
                    query: 'romantic jazz piano evening intimate',
                },
            },
        ],
    },
    {
        // Focus: clean cool white light — clinical, sharp, no distraction
        id: 'focus',
        name: 'Concentration',
        icon: 'lucide:brain',
        color: '#64748B',
        description: 'Blanc froid à 100% — silence et clarté',
        builtIn: true,
        createdAt: 0,
        actions: [
            { tool: '_lights_all_on', args: {} },
            { tool: '_lights_all_brightness', args: { brightness: 100 } },
            { tool: '_lights_all_color', args: { color: '#E0EEFF' } },
            { tool: 'pause_music', args: {} },
        ],
    },
    {
        // Sleep: 5 minutes of dim red to ease melatonin, then off — lock everything
        id: 'sleep',
        name: 'Bonne nuit',
        icon: 'lucide:moon',
        color: '#4F46E5',
        description:
            'Rouge hypnotique 5%, puis extinction — portes verrouillées',
        builtIn: true,
        createdAt: 0,
        actions: [
            { tool: 'pause_music', args: {} },
            { tool: '_lights_all_brightness', args: { brightness: 5 } },
            { tool: '_lights_all_color', args: { color: '#3D0000' } },
            { tool: '_doors_lock_all', args: {} },
            { tool: '_lights_all_off', args: {}, delayMs: 300000 }, // off after 5 min
        ],
    },
    {
        // Rave: pure RGB chaos — maximum saturation, high brightness, hard electronic
        id: 'rave',
        name: 'Rave',
        icon: 'lucide:zap',
        color: '#A855F7',
        description: 'RGB saturé à fond — électro maximal',
        builtIn: true,
        createdAt: 0,
        actions: [
            { tool: '_lights_all_on', args: {} },
            {
                tool: '_lights_palette',
                args: {
                    colors: [
                        '#FF0000',
                        '#00FF00',
                        '#0000FF',
                        '#FF00FF',
                        '#FFFF00',
                        '#00FFFF',
                    ],
                    brightness: 100,
                },
            },
            {
                tool: 'play_music',
                args: {
                    speakerName: 'Salon',
                    query: 'hardstyle rave electronic festival',
                },
            },
        ],
    },
];

// ── Storage ───────────────────────────────────────────────────────────────────

const SCENES_FILE = path.resolve(process.cwd(), 'data/scenes.json');

function ensureDataDir(): void {
    const dir = path.dirname(SCENES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadUserScenes(): Scene[] {
    try {
        if (!fs.existsSync(SCENES_FILE)) return [];
        return JSON.parse(fs.readFileSync(SCENES_FILE, 'utf-8')) as Scene[];
    } catch {
        return [];
    }
}

function saveUserScenes(scenes: Scene[]): void {
    ensureDataDir();
    fs.writeFileSync(SCENES_FILE, JSON.stringify(scenes, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function listScenes(): Scene[] {
    return [...BUILTIN_SCENES, ...loadUserScenes()];
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
    const userScenes = loadUserScenes();
    userScenes.push(scene);
    saveUserScenes(userScenes);
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
    const userScenes = loadUserScenes().filter((s) => s.id !== id);
    saveUserScenes(userScenes);
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
        case '_lights_all_off': {
            const lights = (await callTool('list_lights', {})) as {
                id: number;
            }[];
            const fn =
                action.tool === '_lights_all_on'
                    ? 'turn_on_light'
                    : 'turn_off_light';
            await Promise.allSettled(
                lights.map((l) => callTool(fn, { lightId: l.id })),
            );
            break;
        }
        case '_lights_all_brightness': {
            const lights = (await callTool('list_lights', {})) as {
                id: number;
            }[];
            await Promise.allSettled(
                lights.map((l) =>
                    callTool('set_brightness', {
                        lightId: l.id,
                        brightness: action.args.brightness,
                    }),
                ),
            );
            break;
        }
        case '_lights_all_color': {
            const lights = (await callTool('list_lights', {})) as {
                id: number;
            }[];
            await Promise.allSettled(
                lights.map((l) =>
                    callTool('set_color', {
                        lightId: l.id,
                        color: action.args.color,
                    }),
                ),
            );
            break;
        }
        case '_lights_palette': {
            const lights = (await callTool('list_lights', {})) as {
                id: number;
            }[];
            const colors = action.args.colors as string[];
            await Promise.allSettled(
                lights.map((l, i) =>
                    Promise.all([
                        callTool('turn_on_light', { lightId: l.id }),
                        callTool('set_brightness', {
                            lightId: l.id,
                            brightness: action.args.brightness,
                        }),
                        callTool('set_color', {
                            lightId: l.id,
                            color: colors[i % colors.length],
                        }),
                    ]),
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

export async function runScene(
    sceneId: string,
    callTool: CallTool,
): Promise<{ success: boolean; error?: string }> {
    const scene = getScene(sceneId);
    if (!scene)
        return { success: false, error: `Scene "${sceneId}" not found` };

    Logger.info(
        `Running scene "${scene.name}" (${scene.actions.length} actions)`,
    );

    for (const action of scene.actions) {
        if (action.delayMs) {
            Logger.debug(`Scene "${scene.name}": waiting ${action.delayMs}ms`);
            await sleep(action.delayMs);
        }
        try {
            if (action.tool.startsWith('_')) {
                await runVirtualAction(action, callTool);
            } else {
                await callTool(action.tool, action.args);
            }
            Logger.debug(`Scene "${scene.name}": ✓ ${action.tool}`);
        } catch (err) {
            Logger.warn(
                `Scene "${scene.name}": action "${action.tool}" failed — ${err}`,
            );
            // Non-fatal: keep running remaining actions
        }
    }

    Logger.info(`Scene "${scene.name}" complete`);
    return { success: true };
}
