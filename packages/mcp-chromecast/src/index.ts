import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ChromecastController } from './ChromecastController';
import { CHROMECAST_TOOLS } from './tools';
import Logger from './logger';

const chromecast = new ChromecastController();

const server = new Server(
    { name: 'mcp-chromecast', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: CHROMECAST_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'cast_youtube': {
                const source = String((args as any).source);
                return { content: [{ type: 'text', text: await chromecast.castYoutube(source) }] };
            }

            case 'cast_netflix': {
                const title = (args as any)?.title as string | undefined;
                return { content: [{ type: 'text', text: await chromecast.castNetflix(title) }] };
            }

            case 'cast_crunchyroll': {
                const title = (args as any)?.title as string | undefined;
                return { content: [{ type: 'text', text: await chromecast.castCrunchyroll(title) }] };
            }

            case 'cast_disney': {
                const title = (args as any)?.title as string | undefined;
                return { content: [{ type: 'text', text: await chromecast.castDisney(title) }] };
            }

            case 'cast_prime': {
                const title = (args as any)?.title as string | undefined;
                return { content: [{ type: 'text', text: await chromecast.castPrime(title) }] };
            }

            case 'cast_media': {
                const url = String((args as any).url);
                return { content: [{ type: 'text', text: await chromecast.castMedia(url) }] };
            }

            case 'cast_stop': {
                return { content: [{ type: 'text', text: await chromecast.castStop() }] };
            }

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    } catch (error) {
        if (error instanceof McpError) throw error;
        Logger.error(`Tool ${name} error: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-chromecast server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-chromecast:', err);
    process.exit(1);
});
