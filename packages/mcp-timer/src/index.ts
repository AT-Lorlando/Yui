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
import { TIMER_TOOLS } from './tools';
import { initTimers, setTimer, cancelTimer, listTimers } from './TimerController';
import Logger from './logger';

const server = new Server(
    { name: 'mcp-timer', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TIMER_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'timer_set': {
                const label = String((args as any).label);
                const duration = Number((args as any).duration_seconds);
                const room = (args as any).room ? String((args as any).room) : undefined;
                const timer = setTimer(label, duration, room);
                const mins = Math.floor(duration / 60);
                const secs = duration % 60;
                const humanDuration = mins > 0
                    ? `${mins}min${secs > 0 ? ` ${secs}s` : ''}`
                    : `${secs}s`;
                return {
                    content: [{
                        type: 'text',
                        text: `Minuteur "${label}" lancé pour ${humanDuration} (id: ${timer.id})${room ? ` — clignotement: ${room}` : ''}.`,
                    }],
                };
            }

            case 'timer_cancel': {
                const id = String((args as any).id);
                const ok = cancelTimer(id);
                return {
                    content: [{
                        type: 'text',
                        text: ok
                            ? `Minuteur ${id} annulé.`
                            : `Minuteur ${id} introuvable.`,
                    }],
                };
            }

            case 'timer_list': {
                const items = listTimers();
                if (items.length === 0) {
                    return { content: [{ type: 'text', text: 'Aucun minuteur actif.' }] };
                }
                const lines = items.map(({ timer, remaining_seconds }) => {
                    const mins = Math.floor(remaining_seconds / 60);
                    const secs = remaining_seconds % 60;
                    const remaining = mins > 0
                        ? `${mins}min ${secs}s restantes`
                        : `${secs}s restantes`;
                    return `[${timer.id}] "${timer.label}" — ${remaining}${timer.room ? ` (${timer.room})` : ''}`;
                });
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
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
    Logger.info('Starting mcp-timer server...');
    initTimers();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-timer running on stdio');
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal error in mcp-timer: ${message}`);
    process.exit(1);
});
