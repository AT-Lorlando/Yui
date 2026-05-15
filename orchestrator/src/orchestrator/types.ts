import { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface McpServerConfig {
    name: string;
    command: string;
    args: string[];
}

export interface CollectedTool {
    serverName: string;
    client: Client;
    tool: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
    };
}
