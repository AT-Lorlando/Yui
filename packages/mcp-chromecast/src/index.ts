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
import { LocalTizenBackend, loadTvConfig } from '@yui/shared';
import { CHROMECAST_TOOLS } from './tools';
import { handleCastApp } from './castAppHandler';
import Logger from './logger';

const chromecast = new ChromecastController();
const tvCfg = loadTvConfig();
const tv = new LocalTizenBackend(tvCfg.ip, tvCfg.mac);

const server = new Server(
    { name: 'mcp-chromecast', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: CHROMECAST_TOOLS };
});

async function withTvOn<T>(cast: Promise<T>): Promise<T> {
    const [, castResult] = await Promise.all([
        tv
            .ensureOn()
            .catch((e) => Logger.warn(`tv.ensureOn failed (continuing): ${e}`)),
        cast,
    ]);
    return castResult;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'cast_youtube': {
                const source = (args as any)?.source as string | undefined;
                return {
                    content: [
                        {
                            type: 'text',
                            text: await withTvOn(
                                chromecast.castYoutube(source),
                            ),
                        },
                    ],
                };
            }

            case 'cast_netflix': {
                const title = (args as any)?.title as string | undefined;
                return {
                    content: [
                        {
                            type: 'text',
                            text: await withTvOn(chromecast.castNetflix(title)),
                        },
                    ],
                };
            }

            case 'cast_crunchyroll': {
                const title = (args as any)?.title as string | undefined;
                return {
                    content: [
                        {
                            type: 'text',
                            text: await withTvOn(
                                chromecast.castCrunchyroll(title),
                            ),
                        },
                    ],
                };
            }

            case 'cast_disney': {
                const title = (args as any)?.title as string | undefined;
                return {
                    content: [
                        {
                            type: 'text',
                            text: await withTvOn(chromecast.castDisney(title)),
                        },
                    ],
                };
            }

            case 'cast_prime': {
                const title = (args as any)?.title as string | undefined;
                return {
                    content: [
                        {
                            type: 'text',
                            text: await withTvOn(chromecast.castPrime(title)),
                        },
                    ],
                };
            }

            case 'cast_app': {
                const text = await withTvOn(
                    handleCastApp((args ?? {}) as any, {
                        netflix: (t) => chromecast.castNetflix(t),
                        youtube: (s) => chromecast.castYoutube(s),
                        crunchyroll: (t) => chromecast.castCrunchyroll(t),
                        disney: (t) => chromecast.castDisney(t),
                        prime: (t) => chromecast.castPrime(t),
                    }),
                );
                return { content: [{ type: 'text', text }] };
            }

            case 'cast_media': {
                const url = String((args as any).url);
                return {
                    content: [
                        {
                            type: 'text',
                            text: await withTvOn(chromecast.castMedia(url)),
                        },
                    ],
                };
            }

            case 'cast_stop': {
                return {
                    content: [
                        { type: 'text', text: await chromecast.castStop() },
                    ],
                };
            }

            case 'find_show': {
                const title = String((args as any).title);
                const res = await chromecast.findShow(title);
                if (!res.platform) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Titre introuvable : "${title}"`,
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                platform: res.platform,
                                title: res.title,
                            }),
                        },
                    ],
                };
            }

            case 'remember_show': {
                const title = String((args as any).title);
                const platform = String((args as any).platform);
                const res = await chromecast.rememberShow(title, platform);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Enregistré : ${
                                res.title ?? title
                            } → ${platform}`,
                        },
                    ],
                };
            }

            case 'list_media': {
                const type = (args as any)?.type as
                    | 'wallpaper'
                    | 'video'
                    | 'all'
                    | undefined;
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(listMediaFiles(type ?? 'all')),
                        },
                    ],
                };
            }

            case 'cast_wallpaper': {
                const file = (args as any)?.file as string | undefined;
                return {
                    content: [
                        {
                            type: 'text',
                            text: await withTvOn(
                                chromecast.castWallpaper(file),
                            ),
                        },
                    ],
                };
            }

            case 'cast_video': {
                const file = (args as any)?.file as string | undefined;
                return {
                    content: [
                        {
                            type: 'text',
                            text: await withTvOn(chromecast.castVideo(file)),
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
        Logger.error(
            `Tool ${name} error: ${JSON.stringify(
                error,
                Object.getOwnPropertyNames(error),
            )}`,
        );
        const message =
            error instanceof Error ? error.message : JSON.stringify(error);
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
