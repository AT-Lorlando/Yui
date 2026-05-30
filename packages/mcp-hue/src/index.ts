import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { EntityStore } from '@yui/shared';
import type { LightEntity } from '@yui/shared';
import HueBridge from './HueBridge';
import HueController from './HueController';
import GoveeClient from './GoveeClient';
import { buildHueTools } from './tools';
import { discoverLights } from './discovery';
import Logger from './logger';

let hue: HueController;
let HUE_TOOLS = buildHueTools([]);
const store = new EntityStore<LightEntity>('mcp-hue');

// Govee LAN devices indexed by their synthetic id ("g:1", "g:2", …)
const goveeById = new Map<string, GoveeClient>();

function isGovee(id: string | number): boolean {
    return typeof id === 'string' && id.startsWith('g:');
}

interface GoveeOps {
    on?: boolean;
    brightness?: number;
    color?: string;
}

async function applyGovee(g: GoveeClient, opts: GoveeOps): Promise<void> {
    const turnOn = opts.on !== false;
    if (!turnOn) {
        await g.on(false);
        return;
    }
    // Order matters: color first (forces RGB mode), then brightness, then on if nothing else.
    if (opts.color !== undefined) await g.color(opts.color);
    if (opts.brightness !== undefined) await g.brightness(opts.brightness);
    if (opts.color === undefined && opts.brightness === undefined) {
        await g.on(true);
    }
}

const server = new Server(
    { name: 'mcp-hue', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: HUE_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'set_lights': {
                const target = String((args as any).target);
                const on =
                    (args as any).on !== undefined
                        ? Boolean((args as any).on)
                        : undefined;
                const brightness =
                    (args as any).brightness !== undefined
                        ? Number((args as any).brightness)
                        : undefined;
                const color =
                    (args as any).color !== undefined
                        ? String((args as any).color)
                        : undefined;

                // Try room first
                try {
                    const msg = await hue.setRoomLights(target, {
                        on,
                        brightness,
                        color,
                    });
                    // Also fire any Govee lights mapped to that room
                    const lcRoom = target.toLowerCase().trim();
                    const matching = store
                        .getAll()
                        .filter(
                            (l) =>
                                isGovee(l.id) &&
                                !ambianceIds.has(String(l.id)) &&
                                l.room?.toLowerCase() === lcRoom,
                        );
                    for (const gl of matching) {
                        const g = goveeById.get(String(gl.id));
                        if (!g) continue;
                        await applyGovee(g, { on, brightness, color });
                        store.updateState(gl.id, {
                            on: on !== false,
                            ...(brightness !== undefined && { brightness }),
                        });
                    }
                    return { content: [{ type: 'text', text: msg }] };
                } catch {
                    // Not a room — try individual light by name
                    const lights = store.getAll();
                    const lc = target.toLowerCase().trim();
                    const light =
                        lights.find((l) => l.name.toLowerCase() === lc) ??
                        lights.find(
                            (l) =>
                                l.name.toLowerCase().includes(lc) ||
                                lc.includes(l.name.toLowerCase()),
                        );

                    if (!light) {
                        const rooms = hue.getRoomNames().join(', ');
                        const names = lights.map((l) => l.name).join(', ');
                        throw new Error(
                            `"${target}" introuvable. Pièces : ${rooms}. Lampes : ${names}`,
                        );
                    }

                    const turnOn = on !== false;

                    if (isGovee(light.id)) {
                        const g = goveeById.get(String(light.id));
                        if (!g)
                            throw new Error(
                                `Govee device "${light.name}" not registered`,
                            );
                        await applyGovee(g, { on, brightness, color });
                        store.updateState(light.id, {
                            on: turnOn,
                            ...(brightness !== undefined && { brightness }),
                        });
                    } else {
                        const lightId = Number(light.id);
                        if (!turnOn) {
                            await hue.setLightState(lightId, false);
                            store.updateState(lightId, { on: false });
                        } else {
                            const ops: Promise<void>[] = [];
                            if (brightness !== undefined) {
                                ops.push(
                                    hue.setLightBrightness(lightId, brightness),
                                );
                            }
                            if (color !== undefined) {
                                ops.push(hue.setLightColor(lightId, color));
                            }
                            if (ops.length === 0) {
                                ops.push(hue.setLightState(lightId, true));
                            }
                            await Promise.all(ops);
                            store.updateState(lightId, {
                                on: true,
                                ...(brightness !== undefined && { brightness }),
                            });
                        }
                    }

                    const parts: string[] = [];
                    if (!turnOn) parts.push('éteint');
                    else {
                        if (brightness !== undefined)
                            parts.push(`luminosité ${brightness}%`);
                        else parts.push('allumé');
                        if (color) parts.push(`couleur ${color}`);
                    }
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `${light.name} : ${parts.join(', ')}`,
                            },
                        ],
                    };
                }
            }

            case 'turn_on_light': {
                const lightId = Number((args as any).lightId);
                await hue.setLightState(lightId, true);
                store.updateState(lightId, { on: true });
                return {
                    content: [
                        { type: 'text', text: `Light ${lightId} turned on.` },
                    ],
                };
            }

            case 'turn_off_light': {
                const lightId = Number((args as any).lightId);
                await hue.setLightState(lightId, false);
                store.updateState(lightId, { on: false });
                return {
                    content: [
                        { type: 'text', text: `Light ${lightId} turned off.` },
                    ],
                };
            }

            case 'set_brightness': {
                const lightId = Number((args as any).lightId);
                const brightness = Number((args as any).brightness);
                await hue.setLightBrightness(lightId, brightness);
                store.updateState(lightId, { brightness });
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Light ${lightId} brightness set to ${brightness}%.`,
                        },
                    ],
                };
            }

            case 'set_color': {
                const lightId = Number((args as any).lightId);
                const color = String((args as any).color);
                await hue.setLightColor(lightId, color);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Light ${lightId} color set to ${color}.`,
                        },
                    ],
                };
            }

            case 'set_room_palette': {
                const room = String((args as any).room);
                const colors = (args as any).colors as string[];
                const brightness =
                    (args as any).brightness !== undefined
                        ? Number((args as any).brightness)
                        : undefined;
                const msg = await hue.setRoomPalette(room, colors, brightness);
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'list_lights': {
                const lights = store
                    .getAll()
                    .filter((l) => !ambianceIds.has(String(l.id)));
                return {
                    content: [
                        { type: 'text', text: JSON.stringify(lights, null, 2) },
                    ],
                };
            }

            case 'turn_off_all_lights': {
                const lights = store
                    .getAll()
                    .filter((l) => !ambianceIds.has(String(l.id)));
                const hueIds = lights
                    .filter((l) => !isGovee(l.id))
                    .map((l) => Number(l.id));
                const goveeLights = lights.filter((l) => isGovee(l.id));
                await Promise.all([
                    hue.setAllLightsState(hueIds, false),
                    ...goveeLights.map((l) => {
                        const g = goveeById.get(String(l.id));
                        return g ? g.on(false) : Promise.resolve();
                    }),
                ]);
                lights.forEach((l) => store.updateState(l.id, { on: false }));
                return {
                    content: [
                        {
                            type: 'text',
                            text: `All ${lights.length} lights turned off.`,
                        },
                    ],
                };
            }

            case 'turn_on_all_lights': {
                const brightness =
                    (args as any)?.brightness !== undefined
                        ? Number((args as any).brightness)
                        : undefined;
                const lights = store
                    .getAll()
                    .filter((l) => !ambianceIds.has(String(l.id)));
                const hueIds = lights
                    .filter((l) => !isGovee(l.id))
                    .map((l) => Number(l.id));
                const goveeLights = lights.filter((l) => isGovee(l.id));
                await Promise.all([
                    hue.setAllLightsState(hueIds, true, brightness),
                    ...goveeLights.map((l) => {
                        const g = goveeById.get(String(l.id));
                        if (!g) return Promise.resolve();
                        return applyGovee(g, { on: true, brightness });
                    }),
                ]);
                lights.forEach((l) =>
                    store.updateState(l.id, {
                        on: true,
                        ...(brightness !== undefined && { brightness }),
                    }),
                );
                return {
                    content: [
                        {
                            type: 'text',
                            text: `All ${lights.length} lights turned on${
                                brightness !== undefined
                                    ? ` at brightness ${brightness}`
                                    : ''
                            }.`,
                        },
                    ],
                };
            }

            case 'refresh_lights': {
                await discoverLights(hue, store);
                const lights = store.getAll();
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Lights refreshed. ${lights.length} lights discovered.`,
                        },
                    ],
                };
            }

            default:
                throw new McpError(
                    ErrorCode.MethodNotFound,
                    `Unknown tool: ${name}`,
                );
        }
    } catch (error) {
        if (error instanceof McpError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        Logger.error(`Tool ${name} failed: ${message}`);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

interface GoveeDeviceConfig {
    ip: string;
    name: string;
    room?: string;
    // 'light': integrated as any other lamp (in list_lights, room hooks, all-off).
    // 'ambiance': hidden from normal aggregations — only addressable by exact name.
    mode?: 'light' | 'ambiance';
}

const ambianceIds = new Set<string>();

function loadGoveeDevices(): GoveeDeviceConfig[] {
    // Multi-device JSON form takes precedence.
    const json = process.env.GOVEE_DEVICES;
    if (json) {
        try {
            const arr = JSON.parse(json);
            if (Array.isArray(arr)) return arr;
        } catch (e) {
            Logger.warn(`GOVEE_DEVICES parse failed: ${e}`);
        }
    }
    // Single-device fallback.
    const ip = process.env.GOVEE_IP;
    if (!ip) return [];
    return [
        {
            ip,
            name: process.env.GOVEE_NAME ?? 'Govee',
            room: process.env.GOVEE_ROOM,
            mode: process.env.GOVEE_MODE === 'ambiance' ? 'ambiance' : 'light',
        },
    ];
}

function registerGoveeDevices(): void {
    const devices = loadGoveeDevices();
    if (!devices.length) return;
    const now = new Date().toISOString();
    const existing = store.getAll();
    const goveeEntities: LightEntity[] = devices.map((dev, i) => {
        const id = `g:${i + 1}`;
        goveeById.set(id, new GoveeClient(dev.ip, dev.name));
        if (dev.mode === 'ambiance') ambianceIds.add(id);
        Logger.info(
            `[govee] registered "${dev.name}" @ ${dev.ip}${
                dev.room ? ` (${dev.room})` : ''
            } as ${id} [${dev.mode ?? 'light'}]`,
        );
        return {
            type: 'light' as const,
            id,
            name: dev.name,
            room: dev.room,
            lastDiscovered: now,
            state: { on: false, brightness: 0, reachable: true },
        };
    });
    store.setAll([...existing, ...goveeEntities]);
    store.saveSnapshot();
}

async function main() {
    Logger.info('Connecting to Hue bridge...');
    const api = await HueBridge.connect();
    hue = new HueController(api);
    Logger.info(
        'Hue bridge connected. Initialising room cache and discovering lights...',
    );

    await hue.initCache();
    await discoverLights(hue, store);
    registerGoveeDevices();
    const lightNames = store.getAll().map((l) => l.name);
    HUE_TOOLS = buildHueTools(hue.getRoomNames(), lightNames);
    Logger.info(`Tools built with rooms: ${hue.getRoomNames().join(', ')}`);
    Logger.info(`Tools built with lights: ${lightNames.join(', ')}`);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-hue server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-hue:', err);
    process.exit(1);
});
