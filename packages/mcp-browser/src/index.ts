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
import PlaywrightController from './PlaywrightController';
import { BROWSER_TOOLS } from './tools';
import Logger from './logger';

const playwright = new PlaywrightController();

const server = new Server(
    { name: 'mcp-browser', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: BROWSER_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'open_browser': {
                const url = String((args as any).url);
                const openResult = await playwright.openBrowser();
                if (openResult.status === 'error') {
                    return {
                        content: [{ type: 'text', text: openResult.message }],
                        isError: true,
                    };
                }
                const navResult = await playwright.goToUrl(url);
                return {
                    content: [{ type: 'text', text: navResult.message }],
                    isError: navResult.status === 'error',
                };
            }

            case 'get_page_content': {
                const result = await playwright.getPageContent();
                return {
                    content: [
                        {
                            type: 'text',
                            text:
                                result.status === 'success'
                                    ? String(result.content ?? result.message)
                                    : result.message,
                        },
                    ],
                    isError: result.status === 'error',
                };
            }

            case 'click_element': {
                const selector = String((args as any).selector);
                const result = await playwright.clickOnElement(selector);
                return {
                    content: [{ type: 'text', text: result.message }],
                    isError: result.status === 'error',
                };
            }

            case 'fill_input': {
                const selector = String((args as any).selector);
                const value = String((args as any).value);
                const result = await playwright.fillAndSubmitInput(
                    selector,
                    value,
                );
                return {
                    content: [{ type: 'text', text: result.message }],
                    isError: result.status === 'error',
                };
            }

            case 'close_browser': {
                const result = await playwright.closeBrowser();
                return {
                    content: [{ type: 'text', text: result.message }],
                    isError: result.status === 'error',
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
        const message =
            error instanceof Error ? error.message : String(error);
        Logger.error(`Tool ${name} failed: ${message}`);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

async function main() {
    Logger.info('Starting Browser MCP server...');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-browser server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-browser:', err);
    process.exit(1);
});
