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
import { TahomaClient } from './TahomaClient';
import { buildSomfyTools } from './tools';
import { handleCoversSet } from './coversSetHandler';
import Logger from './logger';

const host = process.env.TAHOMA_HOST ?? '';
const port = parseInt(process.env.TAHOMA_PORT ?? '8443', 10);
const token = process.env.TAHOMA_TOKEN ?? '';

if (!host || !token) {
    Logger.error('mcp-somfy: missing TAHOMA_HOST or TAHOMA_TOKEN in .env');
    process.exit(1);
}

const tahoma = new TahomaClient(host, port, token);

let SOMFY_TOOL_LIST = buildSomfyTools();

const server = new Server(
    { name: 'mcp-somfy', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: SOMFY_TOOL_LIST };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
        switch (name) {
            case 'list_covers': {
                // Auto-refresh to dodge Tahoma cache being stale (occasional partial /setup response)
                try {
                    await tahoma.fetchDevices();
                } catch {
                    /* serve cached on error */
                }
                const covers = tahoma.listCovers();
                if (covers.length === 0) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'Aucun volet/store trouvé. Essaie refresh_covers.',
                            },
                        ],
                    };
                }
                const lines = covers.map((c) => {
                    const pos =
                        c.position != null
                            ? `${c.position}%`
                            : 'position inconnue';
                    return `• ${c.name} [${c.uiClass}] — ${pos}\n  URL: ${c.url}`;
                });
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            case 'open_cover': {
                const device = String(a.device);
                const d = tahoma.resolveDevice(device);
                if (!d)
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Device introuvable : "${device}". Appelle list_covers pour voir les noms disponibles.`,
                            },
                        ],
                        isError: true,
                    };
                await tahoma.exec(d.deviceURL, 'open', [], `Ouvrir ${d.label}`);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `${d.label} : ouverture en cours.`,
                        },
                    ],
                };
            }

            case 'close_cover': {
                const device = String(a.device);
                const d = tahoma.resolveDevice(device);
                if (!d)
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Device introuvable : "${device}".`,
                            },
                        ],
                        isError: true,
                    };
                await tahoma.exec(
                    d.deviceURL,
                    'close',
                    [],
                    `Fermer ${d.label}`,
                );
                return {
                    content: [
                        {
                            type: 'text',
                            text: `${d.label} : fermeture en cours.`,
                        },
                    ],
                };
            }

            case 'set_cover_position': {
                const device = String(a.device);
                const position = Math.round(Number(a.position));
                const d = tahoma.resolveDevice(device);
                if (!d)
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Device introuvable : "${device}".`,
                            },
                        ],
                        isError: true,
                    };
                // setClosure: 0=open, 100=closed (matches our convention)
                await tahoma.exec(
                    d.deviceURL,
                    'setClosure',
                    [position],
                    `${d.label} → ${position}%`,
                );
                return {
                    content: [
                        {
                            type: 'text',
                            text: `${d.label} : position réglée à ${position}% (0=ouvert, 100=fermé).`,
                        },
                    ],
                };
            }

            case 'stop_cover': {
                const device = String(a.device);
                const d = tahoma.resolveDevice(device);
                if (!d)
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Device introuvable : "${device}".`,
                            },
                        ],
                        isError: true,
                    };
                await tahoma.exec(d.deviceURL, 'stop', [], `Stop ${d.label}`);
                return {
                    content: [{ type: 'text', text: `${d.label} : arrêt.` }],
                };
            }

            case 'my_position': {
                const device = String(a.device);
                const d = tahoma.resolveDevice(device);
                if (!d)
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Device introuvable : "${device}".`,
                            },
                        ],
                        isError: true,
                    };
                await tahoma.exec(d.deviceURL, 'my', [], `My ${d.label}`);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `${d.label} : position "My" en cours.`,
                        },
                    ],
                };
            }

            case 'refresh_covers': {
                const devices = await tahoma.fetchDevices();
                const covers = tahoma.listCovers();
                return {
                    content: [
                        {
                            type: 'text',
                            text: `${devices.length} devices récupérés, ${covers.length} volets/stores détectés.`,
                        },
                    ],
                };
            }

            case 'covers_set': {
                const msg = await handleCoversSet(a, {
                    listCovers: () => tahoma.listCovers(),
                    exec: (url, cmd, params, label) =>
                        tahoma.exec(url, cmd, params, label),
                });
                return { content: [{ type: 'text', text: msg }] };
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
        Logger.error(`Tool "${name}" error: ${message}`);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

async function main() {
    Logger.info(`mcp-somfy: connecting to ${host}:${port}…`);
    try {
        await tahoma.fetchDevices();
        SOMFY_TOOL_LIST = buildSomfyTools(
            tahoma.listCovers().map((c) => c.name),
        );
        Logger.info(`mcp-somfy: ${tahoma.listCovers().length} cover(s) ready`);
    } catch (err) {
        Logger.warn(
            `mcp-somfy: initial fetch failed (${
                err instanceof Error ? err.message : err
            }) — will retry on first tool call`,
        );
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-somfy server running on stdio');
}

main().catch((err) => {
    Logger.error(`Fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
