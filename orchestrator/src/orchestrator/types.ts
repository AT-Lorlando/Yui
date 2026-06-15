import { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface McpServerConfig {
    name: string;
    command: string;
    args: string[];
    /**
     * Extra env vars injected at spawn (from data/integrations.json). They take
     * precedence over the package's own dotenv load (dotenv never overrides an
     * already-set var). See integrations.ts.
     */
    env?: Record<string, string>;
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
