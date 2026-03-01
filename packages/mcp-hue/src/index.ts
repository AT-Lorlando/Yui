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
            case 'set_room_lights': {
                const room = String((args as any).room);
                const on = (args as any).on !== undefined ? Boolean((args as any).on) : undefined;
                const brightness = (args as any).brightness !== undefined
                    ? Number((args as any).brightness)
                    : undefined;
                const color = (args as any).color !== undefined
                    ? String((args as any).color)
                    : undefined;
                const msg = await hue.setRoomLights(room, { on, brightness, color });
                return {
                    content: [{ type: 'text', text: msg }],
                };
            }

            case 'list_lights': {
                const lights = store.getAll();
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(lights, null, 2),
                        },
                    ],
                };
            }

            case 'turn_on_light': {
                const lightId = Number((args as any).lightId);
                await hue.setLightState(lightId, true);
                store.updateState(lightId, { on: true });
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Light ${lightId} turned on successfully.`,
                        },
                    ],
                };
            }

            case 'turn_off_light': {
                const lightId = Number((args as any).lightId);
                await hue.setLightState(lightId, false);
                store.updateState(lightId, { on: false });
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Light ${lightId} turned off successfully.`,
                        },
                    ],
                };
            }

            case 'set_brightness': {
                const lightId = Number((args as any).lightId);
                const brightness = Number((args as any).brightness);
                await hue.setLightBrightness(lightId, brightness);
                store.updateState(lightId, { on: true, brightness });
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Light ${lightId} brightness set to ${brightness}.`,
                        },
                    ],
                };
            }

            case 'set_color': {
                const lightId = Number((args as any).lightId);
                const color = String((args as any).color);
                await hue.setLightColor(lightId, color);
                store.updateState(lightId, { on: true });
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Light ${lightId} color set to ${color}.`,
                        },
                    ],
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
    HUE_TOOLS = buildHueTools(hue.getRoomNames());
    Logger.info(`Tools built with rooms: ${hue.getRoomNames().join(', ')}`);

    await discoverLights(hue, store);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-hue server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-hue:', err);
    process.exit(1);
});
