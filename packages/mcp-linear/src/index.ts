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
import { LinearClient } from './LinearClient';
import { LINEAR_TOOLS } from './tools';
import Logger from './logger';

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
    console.error('Missing LINEAR_API_KEY in .env');
    process.exit(1);
}

const linear = new LinearClient(apiKey);

const server = new Server(
    { name: 'mcp-linear', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: LINEAR_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'list_issues': {
                const issues = await linear.listIssues({
                    status: (args as any)?.status,
                    projectId: (args as any)?.projectId,
                    limit: (args as any)?.limit,
                });
                return { content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }] };
            }

            case 'get_issue': {
                const issue = await linear.getIssue(String((args as any).id));
                return { content: [{ type: 'text', text: JSON.stringify(issue, null, 2) }] };
            }

            case 'create_issue': {
                const issue = await linear.createIssue({
                    title: String((args as any).title),
                    description: (args as any)?.description,
                    status: (args as any)?.status,
                    projectId: (args as any)?.projectId,
                });
                return { content: [{ type: 'text', text: `Created issue ${issue.identifier}: ${issue.title}\n${issue.url}` }] };
            }

            case 'update_issue': {
                const result = await linear.updateIssue(String((args as any).id), {
                    title: (args as any)?.title,
                    description: (args as any)?.description,
                    status: (args as any)?.status,
                });
                return { content: [{ type: 'text', text: `Updated ${result.identifier}: ${result.updated.join(', ')}` }] };
            }

            case 'add_comment': {
                const result = await linear.addComment(
                    String((args as any).id),
                    String((args as any).body),
                );
                return { content: [{ type: 'text', text: `Comment added to ${result.identifier}` }] };
            }

            case 'list_projects': {
                const projects = await linear.listProjects();
                return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
            }

            case 'create_project': {
                const project = await linear.createProject(
                    String((args as any).name),
                    (args as any)?.description,
                );
                return { content: [{ type: 'text', text: `Created project "${project.name}" (${project.id})\n${project.url}` }] };
            }

            case 'search_issues': {
                const issues = await linear.searchIssues(
                    String((args as any).query),
                    (args as any)?.limit,
                );
                return { content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }] };
            }

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    } catch (error) {
        if (error instanceof McpError) throw error;
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        Logger.error(`Tool ${name} failed: ${message}`);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

async function main() {
    Logger.info(`mcp-linear starting (team: ${linear.teamName})`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-linear server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-linear:', err);
    process.exit(1);
});
