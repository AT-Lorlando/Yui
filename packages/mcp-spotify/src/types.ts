import type SpotifyWebApi from 'spotify-web-api-node';

export type McpContent = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: true;
};

/** JSON-schema tool definition as returned by tools/list. */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface ToolContext {
    api: SpotifyWebApi;
    /** Spotify Connect device name used when a play tool gets no speakerName. */
    defaultSpeaker: string;
}

export type ToolHandler = (
    args: Record<string, unknown>,
    ctx: ToolContext,
) => Promise<McpContent>;

/**
 * One domain (playback, playlists, library…). `handlers` keys must match
 * `tools[].name` exactly — checked by the registry test.
 */
export interface ToolModule {
    tools: ToolDefinition[];
    handlers: Record<string, ToolHandler>;
}

export const text = (t: string): McpContent => ({
    content: [{ type: 'text', text: t }],
});

export const json = (v: unknown): McpContent =>
    text(JSON.stringify(v, null, 2));

export const fail = (t: string): McpContent => ({
    content: [{ type: 'text', text: t }],
    isError: true,
});

/** Spotify errors carry statusCode; surface 403 as a scope problem. */
export function describeError(err: unknown): string {
    const e = err as { statusCode?: number; message?: string; body?: any };
    const status = e?.statusCode;
    const apiMsg = e?.body?.error?.message;
    const msg = apiMsg || e?.message || String(err);
    if (status === 403) {
        return `${msg} (403 — le token n'a probablement pas le scope requis : relancer \`npm run setup\`).`;
    }
    if (status === 404 && /device/i.test(msg)) {
        return `${msg} (aucun appareil Spotify Connect actif — ouvre Spotify sur un appareil ou passe speakerName).`;
    }
    return status ? `${msg} (HTTP ${status})` : msg;
}
