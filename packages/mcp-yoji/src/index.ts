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
import { YojiClient } from './YojiClient';
import { YOJI_TOOLS } from './tools';
import Logger from './logger';

const baseUrl = process.env.YOJI_API_URL ?? 'http://localhost:3000/api/v1';
const apiKey = process.env.YOJI_API_KEY;

const yoji = new YojiClient({ baseUrl, apiKey });

const server = new Server(
    { name: 'mcp-yoji', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: YOJI_TOOLS };
});

const json = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});
const msg = (text: string) => ({ content: [{ type: 'text' as const, text }] });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, any>;

    try {
        switch (name) {
            case 'list_notes':
                return json(await yoji.listNotes());
            case 'get_note':
                return json(await yoji.getNote(String(a.path)));
            case 'create_note':
                await yoji.createNote(String(a.path), String(a.content ?? ''));
                return msg(`Note created: ${a.path}`);
            case 'update_note':
                await yoji.updateNote(String(a.path), String(a.content));
                return msg(`Note updated: ${a.path}`);
            case 'delete_note':
                await yoji.deleteNote(String(a.path));
                return msg(`Note deleted: ${a.path}`);
            case 'move_note':
                await yoji.moveNote(String(a.from), String(a.to));
                return msg(`Moved: ${a.from} -> ${a.to}`);
            case 'search_notes':
                return json(await yoji.searchNotes(String(a.query)));
            case 'list_folders':
                return json(await yoji.listFolders());
            case 'create_folder':
                await yoji.createFolder(String(a.path));
                return msg(`Folder created: ${a.path}`);
            case 'sync_vault':
                return json(await yoji.syncVault());
            case 'list_tasks':
                return json(
                    await yoji.listTasks({
                        state: a.state,
                        project: a.project,
                    }),
                );
            case 'create_task': {
                const task = await yoji.createTask({
                    title: String(a.title),
                    state: a.state,
                    project: a.project,
                    parent: a.parent,
                    description: a.description,
                    priority: a.priority,
                });
                return msg(`Task created: ${task.title} (${task.id})`);
            }
            case 'update_task': {
                await yoji.updateTask(String(a.id), {
                    title: a.title,
                    state: a.state,
                    description: a.description,
                    priority: a.priority,
                });
                return msg(`Task updated: ${a.id}`);
            }
            case 'delete_task':
                await yoji.deleteTask(String(a.id));
                return msg(`Task deleted: ${a.id}`);
            case 'list_todo_projects':
                return json(await yoji.listProjects());
            case 'create_todo_project': {
                const project = await yoji.createProject(
                    String(a.name),
                    a.description,
                );
                return msg(
                    `Project created: ${project.name} (${project.path})`,
                );
            }
            case 'delete_todo_project':
                await yoji.deleteProject(String(a.path));
                return msg(`Project deleted: ${a.path}`);
            default:
                throw new McpError(
                    ErrorCode.MethodNotFound,
                    `Unknown tool: ${name}`,
                );
        }
    } catch (error) {
        if (error instanceof McpError) throw error;
        const message =
            error instanceof Error ? error.message : JSON.stringify(error);
        Logger.error(`Tool ${name} failed: ${message}`);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info(`mcp-yoji server running on stdio (api: ${baseUrl})`);
}

main().catch((err) => {
    console.error('Fatal error in mcp-yoji:', err);
    process.exit(1);
});
