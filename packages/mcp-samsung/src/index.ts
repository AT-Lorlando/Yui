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
import { SamsungController } from './SamsungController';
import { SAMSUNG_TOOLS } from './tools';
import Logger from './logger';

const token = process.env.SMARTTHINGS_TOKEN;
const deviceId = process.env.SMARTTHINGS_TV_DEVICE_ID;
const mac = process.env.SMARTTHINGS_TV_MAC;
const tvIp = process.env.SMARTTHINGS_TV_IP;

if (!token || !deviceId) {
    console.error('Missing SMARTTHINGS_TOKEN or SMARTTHINGS_TV_DEVICE_ID in .env');
    process.exit(1);
}

const tv = new SamsungController(token, deviceId, mac, tvIp);

const server = new Server(
    { name: 'mcp-samsung', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: SAMSUNG_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'tv_get_status': {
                const status = await tv.getStatus();
                const inputs = await tv.getSupportedInputs();
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ ...status, supportedInputs: inputs }, null, 2),
                    }],
                };
            }

            case 'tv_power': {
                const state = String((args as any).state) as 'on' | 'off';
                if (state === 'on') {
                    await tv.powerOn();
                } else {
                    await tv.powerOff();
                }
                return { content: [{ type: 'text', text: `TV turned ${state}.` }] };
            }

            case 'tv_set_volume': {
                const level = Number((args as any).level);
                await tv.setVolume(level);
                return { content: [{ type: 'text', text: `TV volume set to ${level}.` }] };
            }

            case 'tv_mute': {
                const mute = Boolean((args as any).mute);
                if (mute) {
                    await tv.mute();
                } else {
                    await tv.unmute();
                }
                return { content: [{ type: 'text', text: `TV ${mute ? 'muted' : 'unmuted'}.` }] };
            }

            case 'tv_prepare_chromecast': {
                const msg = await tv.prepareChromecast();
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'tv_set_input': {
                const source = String((args as any).source);
                await tv.setInputSource(source);
                return { content: [{ type: 'text', text: `TV input switched to ${source}.` }] };
            }

            case 'tv_launch_app': {
                const appId = String((args as any).appId);
                const appName = (args as any)?.appName as string | undefined;
                await tv.launchApp(appId);
                return { content: [{ type: 'text', text: `Launched ${appName ?? appId} on TV.` }] };
            }

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    } catch (error) {
        if (error instanceof McpError) throw error;
        Logger.error(`Tool ${name} raw error: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
        const message = error instanceof Error
            ? error.message
            : (error as any)?.response?.data?.message ?? (error as any)?.message ?? JSON.stringify(error);
        Logger.error(`Tool ${name} failed: ${message}`);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

async function main() {
    Logger.info('mcp-samsung starting...');

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-samsung server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-samsung:', err);
    process.exit(1);
});
