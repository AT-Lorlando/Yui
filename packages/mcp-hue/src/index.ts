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
import {
    startAmbiance,
    stopAmbiance,
    listAmbiance,
    stopAllAmbiance,
} from './GoveeAmbiance';
import { buildHueTools } from './tools';
import { discoverLights } from './discovery';
import Logger from './logger';

let hue: HueController;
let HUE_TOOLS = buildHueTools([]);
const store = new EntityStore<LightEntity>('mcp-hue');

// Govee LAN devices indexed by their synthetic id ("g:1", "g:2", …)
const goveeById = new Map<string, GoveeClient>();
const goveeChannel = new Map<string, 'cct' | 'rgb'>(); // per-id channel routing

function isGovee(id: string | number): boolean {
    return typeof id === 'string' && id.startsWith('g:');
}

interface GoveeOps {
    on?: boolean;
    brightness?: number;
    color?: string; // hex (#RRGGBB) — interpretation depends on channel
}

/** Rough hex → kelvin estimate for CCT channels. Warm reds → 2700, cold blues → 6500. */
function hexToKelvin(hex: string): number {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return 4000;
    const r = parseInt(m[1], 16);
    const b = parseInt(m[3], 16);
    // Pure white → 4000K, warm bias → 2700K, cool bias → 6500K
    if (r > b + 40) return 2700;
    if (b > r + 40) return 6500;
    if (r > b + 10) return 3200;
    if (b > r + 10) return 5500;
    return 4000;
}

async function applyGovee(
    g: GoveeClient,
    opts: GoveeOps,
    channel: 'cct' | 'rgb',
): Promise<void> {
    const turnOn = opts.on !== false;
    if (!turnOn) {
        // Shared physical device — caller is responsible for the trade-off
        // (turning off one logical light kills the whole lamp).
        await g.on(false);
        return;
    }
    // For CCT: color → kelvin, brightness applies globally.
    // For RGB: color → colorwc, brightness applies globally.
    if (channel === 'cct') {
        if (opts.color !== undefined)
            await g.colorTemperature(hexToKelvin(opts.color));
    } else {
        if (opts.color !== undefined) await g.color(opts.color);
    }
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
                const transitionMs =
                    (args as any).transitionMs !== undefined
                        ? Number((args as any).transitionMs)
                        : undefined;

                // Try room first
                try {
                    const msg = await hue.setRoomLights(target, {
                        on,
                        brightness,
                        color,
                        transitionMs,
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
                        const ch = goveeChannel.get(String(gl.id)) ?? 'rgb';
                        await applyGovee(g, { on, brightness, color }, ch);
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
                        const ch = goveeChannel.get(String(light.id)) ?? 'rgb';
                        // Explicit manual control wins over a running ambiance
                        // loop — otherwise it keeps overriding this state (e.g.
                        // the lamp never turns off).
                        stopAmbiance(String(light.id));
                        await applyGovee(g, { on, brightness, color }, ch);
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
                                ops.push(
                                    hue.setLightColor(
                                        lightId,
                                        color,
                                        transitionMs,
                                    ),
                                );
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
                // Stop any running Govee ambiance loop — otherwise it keeps
                // sending colorwc packets and visually re-activates the lamp.
                stopAllAmbiance();
                // Ambiance IS turned off here (per user requirement) — only excluded from all_on.
                const lights = store.getAll();
                const hueIds = lights
                    .filter((l) => !isGovee(l.id))
                    .map((l) => Number(l.id));
                // Dedupe Govee by IP — multiple logical lights may share one device.
                const goveeIps = new Set<string>();
                const goveeOffs: Promise<void>[] = [];
                for (const l of lights.filter((x) => isGovee(x.id))) {
                    const g = goveeById.get(String(l.id));
                    if (g && !goveeIps.has(g.ip)) {
                        goveeIps.add(g.ip);
                        goveeOffs.push(g.on(false).catch(() => {}));
                    }
                }
                await Promise.all([
                    hue.setAllLightsState(hueIds, false),
                    ...goveeOffs,
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
                // Ambiance is excluded from all_on (only triggered explicitly via scenes/bindings).
                const lights = store
                    .getAll()
                    .filter((l) => !ambianceIds.has(String(l.id)));
                const hueIds = lights
                    .filter((l) => !isGovee(l.id))
                    .map((l) => Number(l.id));
                // Dedupe Govee by IP — multiple logical lights may share one device.
                const goveeIps = new Set<string>();
                const goveeOns: Promise<void>[] = [];
                for (const l of lights.filter((x) => isGovee(x.id))) {
                    const g = goveeById.get(String(l.id));
                    if (g && !goveeIps.has(g.ip)) {
                        goveeIps.add(g.ip);
                        const ch = goveeChannel.get(String(l.id)) ?? 'rgb';
                        goveeOns.push(
                            applyGovee(g, { on: true, brightness }, ch).catch(
                                () => {},
                            ),
                        );
                    }
                }
                await Promise.all([
                    hue.setAllLightsState(hueIds, true, brightness),
                    ...goveeOns,
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

            case 'govee_ambiance_start': {
                const targetName = String((args as any).device);
                const presetId = String((args as any).preset);
                const lights = store.getAll().filter((l) => isGovee(l.id));
                const lc = targetName.toLowerCase().trim();
                const light =
                    lights.find((l) => l.name.toLowerCase() === lc) ??
                    lights.find((l) => l.name.toLowerCase().includes(lc));
                if (!light) {
                    throw new Error(
                        `Govee device "${targetName}" introuvable. Dispos : ${lights
                            .map((l) => l.name)
                            .join(', ')}`,
                    );
                }
                const g = goveeById.get(String(light.id));
                if (!g) throw new Error('Govee client not registered');
                const preset = startAmbiance(String(light.id), presetId, g);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Ambiance "${preset.name}" lancée sur ${light.name}.`,
                        },
                    ],
                };
            }

            case 'govee_ambiance_stop': {
                const targetName = String((args as any).device);
                const lights = store.getAll().filter((l) => isGovee(l.id));
                const lc = targetName.toLowerCase().trim();
                const light =
                    lights.find((l) => l.name.toLowerCase() === lc) ??
                    lights.find((l) => l.name.toLowerCase().includes(lc));
                if (!light)
                    throw new Error(
                        `Govee device "${targetName}" introuvable.`,
                    );
                const stopped = stopAmbiance(String(light.id));
                return {
                    content: [
                        {
                            type: 'text',
                            text: stopped
                                ? `Ambiance arrêtée sur ${light.name}.`
                                : `Aucune ambiance active sur ${light.name}.`,
                        },
                    ],
                };
            }

            case 'govee_ambiance_list': {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(listAmbiance(), null, 2),
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
    // 'light': integrated as any other lamp (in list_lights, room hooks, all-on/off).
    // 'ambiance': hidden from list_lights + all-on. Still affected by all-off.
    mode?: 'light' | 'ambiance';
    // 'rgb' (default): colorwc with RGB → all currently-active RGB zones.
    // 'cct': colorwc with kelvin → the white CCT bulb (e.g. H60B0 lower).
    channel?: 'cct' | 'rgb';
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
            channel: process.env.GOVEE_CHANNEL === 'cct' ? 'cct' : 'rgb',
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
        goveeChannel.set(id, dev.channel ?? 'rgb');
        if (dev.mode === 'ambiance') ambianceIds.add(id);
        Logger.info(
            `[govee] registered "${dev.name}" @ ${dev.ip}${
                dev.room ? ` (${dev.room})` : ''
            } as ${id} [${dev.mode ?? 'light'}/${dev.channel ?? 'rgb'}]`,
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
