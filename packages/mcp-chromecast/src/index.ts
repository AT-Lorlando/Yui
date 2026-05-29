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
import { ChromecastController, listMediaFiles } from './ChromecastController';
import { TvController } from './TvController';
import { CHROMECAST_TOOLS } from './tools';
import Logger from './logger';

const chromecast = new ChromecastController();
const tv = new TvController(
    process.env.SMARTTHINGS_TV_IP ?? '10.0.0.133',
    process.env.SMARTTHINGS_TV_MAC,
);

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
                const source = (args as any)?.source as string | undefined;
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

            case 'find_show': {
                const title = String((args as any).title);
                const res = await chromecast.findShow(title);
                if (!res.platform) {
                    return { content: [{ type: 'text', text: `Titre introuvable : "${title}"` }] };
                }
                return {
                    content: [{ type: 'text', text: JSON.stringify({ platform: res.platform, title: res.title }) }],
                };
            }

            case 'remember_show': {
                const title = String((args as any).title);
                const platform = String((args as any).platform);
                const res = await chromecast.rememberShow(title, platform);
                return {
                    content: [{ type: 'text', text: `Enregistré : ${res.title ?? title} → ${platform}` }],
                };
            }

            case 'list_media': {
                const type = (args as any)?.type as 'wallpaper' | 'video' | 'all' | undefined;
                return { content: [{ type: 'text', text: JSON.stringify(listMediaFiles(type ?? 'all')) }] };
            }

            case 'cast_wallpaper': {
                const file = (args as any)?.file as string | undefined;
                return { content: [{ type: 'text', text: await chromecast.castWallpaper(file) }] };
            }

            case 'cast_video': {
                const file = (args as any)?.file as string | undefined;
                return { content: [{ type: 'text', text: await chromecast.castVideo(file) }] };
            }

            case 'tv_on': {
                const msg = await tv.powerOn();
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'tv_off': {
                // Stop Chromecast first, then power off TV in parallel
                const [, tvMsg] = await Promise.allSettled([
                    chromecast.castStop(),
                    tv.powerOff(),
                ]);
                const msg = tvMsg.status === 'fulfilled' ? tvMsg.value : 'TV turned off.';
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'tv_volume': {
                const level = Number((args as any).level);
                await tv.setVolume(level);
                return { content: [{ type: 'text', text: `TV volume set to ${level}.` }] };
            }

            case 'tv_mute': {
                const mute = Boolean((args as any).mute);
                await tv.mute();
                return { content: [{ type: 'text', text: `TV ${mute ? 'muted' : 'unmuted'}.` }] };
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
