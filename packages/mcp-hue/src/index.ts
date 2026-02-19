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
import { HUE_TOOLS } from './tools';
import { discoverLights } from './discovery';
import Logger from './logger';

let hue: HueController;
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
    Logger.info('Hue bridge connected. Discovering lights...');

    await discoverLights(hue, store);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-hue server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-hue:', err);
    process.exit(1);
});
