import * as path from 'path';
import type { McpServerConfig } from './types';

/**
 * Builds the list of MCP server configurations.
 * In production (compiled .js) uses pre-built packages to avoid ts-node overhead.
 * In dev (ts-node) runs source directly so changes are picked up immediately.
 */
export function buildServerConfigs(): McpServerConfig[] {
    const root = path.resolve(__dirname, '../..');
    const compiled = __filename.endsWith('.js');

    const mcp = (pkg: string): McpServerConfig =>
        compiled
            ? {
                  name: pkg,
                  command: 'node',
                  args: [path.join(root, `packages/${pkg}/dist/index.js`)],
              }
            : {
                  name: pkg,
                  command: 'npx',
                  args: [
                      'ts-node',
                      path.join(root, `packages/${pkg}/src/index.ts`),
                  ],
              };

    return [
        mcp('mcp-hue'),
        mcp('mcp-nuki'),
        mcp('mcp-spotify'),
        mcp('mcp-linear'),
        mcp('mcp-samsung'),
        mcp('mcp-chromecast'),
        mcp('mcp-calendar'),
        mcp('mcp-weather'),
        mcp('mcp-obsidian'),
        mcp('mcp-gmail'),
        // mcp('mcp-browser'), // Phase 2
    ];
}
