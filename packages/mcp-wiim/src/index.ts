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
import { WiimClient } from './WiimClient';
import Logger from './logger';

const WIIM_IP = process.env.WIIM_IP ?? '';
const wiim = new WiimClient(WIIM_IP);

const TOOLS = [
    {
        name: 'wiim_status',
        description:
            "État de l'enceinte WiiM (toutes sources : Spotify, Tidal Connect, " +
            'Bluetooth…) : lecture en cours, volume, titre, source.',
        inputSchema: {
            type: 'object' as const,
            'x-audience': ['llm'],
            properties: {},
            required: [],
        },
    },
    {
        name: 'wiim_volume',
        description:
            "Règle le volume de l'enceinte WiiM — local et universel, marche " +
            'quelle que soit la source. percent = absolu, delta = relatif ' +
            '("monte un peu le son" → delta 10).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                percent: {
                    type: 'number',
                    title: 'Volume',
                    minimum: 0,
                    maximum: 100,
                    'x-unit': '%',
                    description: 'Volume absolu 0-100.',
                },
                delta: {
                    type: 'number',
                    title: 'Variation',
                    minimum: -100,
                    maximum: 100,
                    'x-unit': '%',
                    description: 'Variation relative. Exclusif avec percent.',
                },
            },
        },
    },
    {
        name: 'wiim_playback',
        description:
            'Transport WiiM, toutes sources : pause, reprise, bascule, ' +
            'piste suivante/précédente, stop.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                action: {
                    type: 'string',
                    title: 'Action',
                    enum: ['pause', 'play', 'toggle', 'next', 'prev', 'stop'],
                },
            },
            required: ['action'],
        },
    },
    {
        name: 'wiim_preset',
        description:
            'Rappelle un preset WiiM (1-12, configurés dans WiiM Home : ' +
            'playlists, radios, albums — y compris Tidal). Idéal en scène.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                preset: {
                    type: 'number',
                    title: 'Preset',
                    minimum: 1,
                    maximum: 12,
                },
            },
            required: ['preset'],
        },
    },
];

const server = new Server(
    { name: 'mcp-wiim', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
}));

const ACTION_CMDS: Record<string, string> = {
    pause: 'pause',
    play: 'resume',
    toggle: 'onepause',
    next: 'next',
    prev: 'prev',
    stop: 'stop',
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!WIIM_IP) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'WIIM_IP non configurée dans .env',
                },
            ],
            isError: true,
        };
    }
    try {
        switch (name) {
            case 'wiim_status': {
                const st = await wiim.getStatus();
                return {
                    content: [
                        { type: 'text', text: JSON.stringify(st, null, 2) },
                    ],
                };
            }
            case 'wiim_volume': {
                const a = args as any;
                let target: number;
                if (a?.percent !== undefined) {
                    target = Number(a.percent);
                } else if (a?.delta !== undefined) {
                    const st = await wiim.getStatus();
                    target = st.volume + Number(a.delta);
                } else {
                    throw new Error('percent ou delta requis');
                }
                target = Math.max(0, Math.min(100, Math.round(target)));
                await wiim.setVolume(target);
                return {
                    content: [{ type: 'text', text: `Volume ${target}%` }],
                };
            }
            case 'wiim_playback': {
                const action = String((args as any).action);
                const cmd = ACTION_CMDS[action];
                if (!cmd) throw new Error(`Action inconnue : ${action}`);
                await wiim.playerCmd(cmd);
                return {
                    content: [{ type: 'text', text: `WiiM : ${action}` }],
                };
            }
            case 'wiim_preset': {
                const n = Number((args as any).preset);
                if (!Number.isInteger(n) || n < 1 || n > 12) {
                    throw new Error('preset doit être entre 1 et 12');
                }
                await wiim.recallPreset(n);
                return {
                    content: [{ type: 'text', text: `Preset ${n} lancé.` }],
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
    if (!WIIM_IP) {
        Logger.warn(
            '[wiim] WIIM_IP absente du .env — tools en erreur explicite',
        );
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info(`mcp-wiim server running on stdio (WiiM @ ${WIIM_IP || '?'})`);
}

main().catch((err) => {
    console.error('Fatal error in mcp-wiim:', err);
    process.exit(1);
});
