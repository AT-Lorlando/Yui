import * as path from 'path';
import type { McpServerConfig } from './types';

/**
 * Tools that are callable via the HTTP API (e.g. mobile app) but must NOT
 * appear in the LLM's tool list. The LLM uses higher-level wrappers instead
 * (e.g. set_lights, set_room_palette) — individual light tools are for
 * direct programmatic control only.
 */
export const LLM_HIDDEN_TOOLS = new Set([
    'turn_on_light',
    'turn_off_light',
    'set_brightness',
    'set_color',
    'list_media',
    'cast_wallpaper',
    'cast_video',
]);

/**
 * Builds the list of MCP server configurations.
 * In production (compiled .js) uses pre-built packages to avoid ts-node overhead.
 * In dev (ts-node) runs source directly so changes are picked up immediately.
 */
export function buildServerConfigs(): McpServerConfig[] {
    const cwd = process.cwd();
    const root = path.basename(cwd) === 'dashboard' ? path.resolve(cwd, '..') : cwd;
    // MCP servers always run compiled JS — ts-node overhead (~1.5 Go/process) is not acceptable
    // Run `npm run build:packages` once before starting the orchestrator in dev mode
    const mcp = (pkg: string): McpServerConfig => ({
        name: pkg,
        command: 'node',
        args: [path.join(root, `packages/${pkg}/dist/index.js`)],
    });

    return [
        mcp('mcp-hue'),
        mcp('mcp-nuki'),
        mcp('mcp-somfy'),
        mcp('mcp-spotify'),
        mcp('mcp-linear'),
        mcp('mcp-chromecast'),
        mcp('mcp-timer'),
        mcp('mcp-calendar'),
        mcp('mcp-weather'),
        mcp('mcp-obsidian'),
        mcp('mcp-gmail'),
        // mcp('mcp-browser'), // Phase 2
        {
            name: 'mcp-search',
            command: 'npx',
            args: ['-y', 'tavily-mcp@latest'],
        },
        mcp('mcp-irrigation'),
    ];
}
