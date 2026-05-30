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
import { IrrigationController } from './IrrigationController';
import { buildIrrigationTools } from './tools';
import type { AmountKey } from './config';
import Logger from './logger';

const irrigation = new IrrigationController();

const server = new Server(
    { name: 'mcp-irrigation', version: '2.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: buildIrrigationTools() };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!irrigation.isConfigured()) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Irrigation non configurée. Renseigner TUYA_DEVICE_ID, TUYA_LOCAL_KEY et TUYA_DEVICE_IP dans .env.',
                },
            ],
            isError: true,
        };
    }

    try {
        switch (name) {
            case 'irrigation_status': {
                const status = await irrigation.getStatus();
                return {
                    content: [
                        { type: 'text', text: JSON.stringify(status, null, 2) },
                    ],
                };
            }

            case 'irrigation_start': {
                const target = String((args as any).target);
                const amount = String((args as any).amount) as AmountKey;
                const msg = await irrigation.startAmount(target, amount);
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'irrigation_stop': {
                const target = String((args as any).target ?? 'all');
                const msg = await irrigation.stop(target);
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'irrigation_discover_dps': {
                const dps = await irrigation.discoverDps();
                return {
                    content: [
                        { type: 'text', text: JSON.stringify(dps, null, 2) },
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

async function main() {
    Logger.info('Starting Irrigation MCP server...');
    if (!irrigation.isConfigured()) {
        Logger.warn(
            'TUYA_DEVICE_ID / TUYA_LOCAL_KEY / TUYA_DEVICE_IP not set — tools will return config error',
        );
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-irrigation server running on stdio');
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal error in mcp-irrigation: ${message}`);
    process.exit(1);
});
