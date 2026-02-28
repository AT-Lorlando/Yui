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
import { GoogleAuth } from './GoogleAuth';
import { GmailClient } from './GmailClient';
import { GMAIL_TOOLS } from './tools';
import Logger from './logger';

let gmail: GmailClient;

const server = new Server(
    { name: 'mcp-gmail', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: GMAIL_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, any>;

    try {
        switch (name) {
            case 'list_emails':
                return {
                    content: [{
                        type: 'text',
                        text: await gmail.listEmails({
                            maxResults: a.maxResults,
                            query: a.query,
                            labelIds: a.labelIds,
                        }),
                    }],
                };

            case 'get_email':
                return {
                    content: [{ type: 'text', text: await gmail.getEmail(a.messageId) }],
                };

            case 'search_emails':
                return {
                    content: [{
                        type: 'text',
                        text: await gmail.searchEmails(a.query, a.maxResults),
                    }],
                };

            case 'send_email':
                return {
                    content: [{
                        type: 'text',
                        text: await gmail.sendEmail(a.to, a.subject, a.body, a.cc),
                    }],
                };

            case 'reply_email':
                return {
                    content: [{
                        type: 'text',
                        text: await gmail.replyEmail(a.messageId, a.body),
                    }],
                };

            case 'create_draft':
                return {
                    content: [{
                        type: 'text',
                        text: await gmail.createDraft(a.to, a.subject, a.body),
                    }],
                };

            case 'trash_email':
                return {
                    content: [{ type: 'text', text: await gmail.trashEmail(a.messageId) }],
                };

            case 'archive_email':
                return {
                    content: [{ type: 'text', text: await gmail.archiveEmail(a.messageId) }],
                };

            case 'mark_read':
                return {
                    content: [{ type: 'text', text: await gmail.markRead(a.messageId) }],
                };

            case 'mark_unread':
                return {
                    content: [{ type: 'text', text: await gmail.markUnread(a.messageId) }],
                };

            case 'list_labels':
                return {
                    content: [{ type: 'text', text: await gmail.listLabels() }],
                };

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
    Logger.info('Connecting to Gmail…');
    const auth = await GoogleAuth.connect();
    gmail = new GmailClient(auth);
    Logger.info('Gmail connected.');

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-gmail server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-gmail:', err);
    process.exit(1);
});
