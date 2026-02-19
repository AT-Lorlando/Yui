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
import { ObsidianClient } from './ObsidianClient';
import { OBSIDIAN_TOOLS } from './tools';
import Logger from './logger';

const VAULT_ROOT = process.env.OBSIDIAN_VAULT_ROOT ?? `${process.env.HOME}/obsidian`;

const obsidian = new ObsidianClient(VAULT_ROOT);

const server = new Server(
    { name: 'mcp-obsidian', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: OBSIDIAN_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
        let text: string;

        switch (name) {
            case 'list_vaults':
                text = obsidian.listVaults();
                break;

            case 'get_tree':
                text = obsidian.getTree(a.path as string | undefined);
                break;

            case 'read_note':
                text = obsidian.readNote(a.path as string);
                break;

            case 'create_note':
                text = obsidian.createNote(
                    a.path as string,
                    (a.content as string | undefined) ?? '',
                );
                break;

            case 'update_note':
                text = obsidian.updateNote(a.path as string, a.content as string);
                break;

            case 'append_to_note':
                text = obsidian.appendToNote(a.path as string, a.text as string);
                break;

            case 'create_folder':
                text = obsidian.createFolder(a.path as string);
                break;

            case 'move_note':
                text = obsidian.move(a.from as string, a.to as string);
                break;

            case 'delete_note':
                text = obsidian.deleteNote(a.path as string);
                break;

            case 'search_notes':
                text = obsidian.searchNotes({
                    query: a.query as string,
                    vault: a.vault as string | undefined,
                    searchContent: a.search_content !== false,
                    limit: a.limit !== undefined ? Number(a.limit) : 20,
                });
                break;

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        return { content: [{ type: 'text', text }] };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.error(`Tool "${name}" error: ${message}`);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info(`mcp-obsidian server running on stdio (vault: ${VAULT_ROOT})`);
}

main().catch((error) => {
    Logger.error(`Fatal error: ${error}`);
    process.exit(1);
});
