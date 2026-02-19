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
import type { DoorEntity } from '@yui/shared';
import NukiController from './NukiController';
import { NUKI_TOOLS } from './tools';
import { discoverDoors } from './discovery';
import Logger from './logger';

const nuki = new NukiController();
const store = new EntityStore<DoorEntity>('mcp-nuki');

const server = new Server(
    { name: 'mcp-nuki', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: NUKI_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'list_doors': {
                const doors = store.getAll();
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(doors, null, 2),
                        },
                    ],
                };
            }

            case 'lock_door': {
                const nukiId = Number((args as any).nukiId);
                const deviceType = Number((args as any).deviceType ?? 0);
                const result = await nuki.lock(nukiId, deviceType);
                store.updateState(nukiId, { stateName: 'locked' });
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Door ${nukiId} locked. Result: ${JSON.stringify(result)}`,
                        },
                    ],
                };
            }

            case 'unlock_door': {
                const nukiId = Number((args as any).nukiId);
                const deviceType = Number((args as any).deviceType ?? 0);
                const result = await nuki.unlock(nukiId, deviceType);
                store.updateState(nukiId, { stateName: 'unlocked' });
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Door ${nukiId} unlocked. Result: ${JSON.stringify(result)}`,
                        },
                    ],
                };
            }

            case 'get_door_state': {
                const nukiId = Number((args as any).nukiId);
                const deviceType = Number((args as any).deviceType ?? 0);
                const state = await nuki.getLockState(nukiId, deviceType);
                store.updateState(nukiId, {
                    stateName: state.stateName ?? 'unknown',
                    batteryCritical: state.batteryCritical ?? false,
                    doorState: state.doorsensorStateName,
                });
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(state, null, 2),
                        },
                    ],
                };
            }

            case 'refresh_doors': {
                await discoverDoors(nuki, store);
                const doors = store.getAll();
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Doors refreshed. ${doors.length} doors discovered.`,
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
    Logger.info('Starting Nuki MCP server...');

    await discoverDoors(nuki, store);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-nuki server running on stdio');
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    console.error(`Fatal error in mcp-nuki: ${message}`);
    if (stack) console.error(stack);
    process.exit(1);
});
