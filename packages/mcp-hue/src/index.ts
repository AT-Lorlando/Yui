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
import { buildHueTools } from './tools';
import { discoverLights } from './discovery';
import Logger from './logger';

let hue: HueController;
let HUE_TOOLS = buildHueTools([]);
const store = new EntityStore<LightEntity>('mcp-hue');

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
                const on = (args as any).on !== undefined ? Boolean((args as any).on) : undefined;
                const brightness = (args as any).brightness !== undefined
                    ? Number((args as any).brightness)
                    : undefined;
                const color = (args as any).color !== undefined
                    ? String((args as any).color)
                    : undefined;

                // Try room first
                try {
                    const msg = await hue.setRoomLights(target, { on, brightness, color });
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

                    const lightId = Number(light.id);
                    const turnOn = on !== false;

                    if (!turnOn) {
                        await hue.setLightState(lightId, false);
                        store.updateState(lightId, { on: false });
                    } else {
                        const ops: Promise<void>[] = [];
                        if (brightness !== undefined) {
                            const bri = Math.max(1, Math.round((brightness / 100) * 254));
                            ops.push(hue.setLightBrightness(lightId, bri));
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

                    const parts: string[] = [];
                    if (!turnOn) parts.push('éteint');
                    else {
                        if (brightness !== undefined) parts.push(`luminosité ${brightness}%`);
                        else parts.push('allumé');
                        if (color) parts.push(`couleur ${color}`);
                    }
                    return {
                        content: [{ type: 'text', text: `${light.name} : ${parts.join(', ')}` }],
                    };
                }
            }

            case 'set_room_palette': {
                const room = String((args as any).room);
                const colors = (args as any).colors as string[];
                const brightness = (args as any).brightness !== undefined
                    ? Number((args as any).brightness)
                    : undefined;
                const msg = await hue.setRoomPalette(room, colors, brightness);
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'list_lights': {
                const lights = store.getAll();
                return {
                    content: [{ type: 'text', text: JSON.stringify(lights, null, 2) }],
                };
            }

            case 'turn_off_all_lights': {
                const lights = store.getAll();
                const ids = lights.map((l) => Number(l.id));
                await hue.setAllLightsState(ids, false);
                lights.forEach((l) => store.updateState(l.id, { on: false }));
                return {
                    content: [
                        {
                            type: 'text',
                            text: `All ${ids.length} lights turned off.`,
                        },
                    ],
                };
            }

            case 'turn_on_all_lights': {
                const brightness = (args as any)?.brightness !== undefined
                    ? Number((args as any).brightness)
                    : undefined;
                const lights = store.getAll();
                const ids = lights.map((l) => Number(l.id));
                await hue.setAllLightsState(ids, true, brightness);
                lights.forEach((l) =>
                    store.updateState(l.id, { on: true, ...(brightness !== undefined && { brightness }) }),
                );
                return {
                    content: [
                        {
                            type: 'text',
                            text: `All ${ids.length} lights turned on${brightness !== undefined ? ` at brightness ${brightness}` : ''}.`,
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
        const message =
            error instanceof Error ? error.message : String(error);
        Logger.error(`Tool ${name} failed: ${message}`);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

async function main() {
    Logger.info('Connecting to Hue bridge...');
    const api = await HueBridge.connect();
    hue = new HueController(api);
    Logger.info('Hue bridge connected. Initialising room cache and discovering lights...');

    await hue.initCache();
    await discoverLights(hue, store);
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
