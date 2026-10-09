// packages/mcp-smartthings/src/index.ts
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
import {
    SmartThingsClient,
    SmartThingsBackend,
    loadSmartThingsCreds,
    loadTvConfig,
    saveTvConfig,
    inputCatalog,
    mergeKnownInputs,
    TvOfflineError,
    type TvStatus,
} from '@yui/shared';
import { currentTools } from './tools';
import Logger from './logger';

// Backend construit paresseusement : si les creds manquent, on ne crashe pas au boot.
let backend: SmartThingsBackend | null = null;
function getBackend(): SmartThingsBackend {
    if (!backend) {
        const creds = loadSmartThingsCreds(); // throw FR si absent
        const client = new SmartThingsClient(creds.deviceId);
        backend = new SmartThingsBackend(client, loadTvConfig());
    }
    return backend;
}

const server = new Server(
    { name: 'mcp-smartthings', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: currentTools() };
});

/**
 * Retient les entrées annoncées par la TV (supportedInputSources) dans
 * smartthings-tv.json : l'enum de `tv_set_input` les propose dès le prochain
 * démarrage de l'orchestrateur, même TV éteinte. Best-effort.
 */
function rememberInputs(s: TvStatus): Record<string, string> {
    const cfg = loadTvConfig();
    const live = s.supportedInputs ?? [];
    try {
        const merged = mergeKnownInputs(cfg, live);
        if (merged) {
            saveTvConfig({ ...cfg, knownInputs: merged });
            Logger.info(`TV : entrées découvertes ${merged.join(', ')}`);
            cfg.knownInputs = merged;
        }
    } catch (e) {
        Logger.warn(`TV : impossible de retenir les entrées (${e})`);
    }
    return inputCatalog(cfg, live);
}

function text(t: string) {
    return { content: [{ type: 'text', text: t }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;
    try {
        const tv = getBackend();
        switch (name) {
            case 'tv_on':
                return text(await tv.ensureOn());
            case 'tv_off':
                return text(await tv.powerOff());
            case 'tv_volume': {
                const level = Number(a.level);
                await tv.setVolume(level);
                return text(`Volume réglé à ${Math.round(level)}.`);
            }
            case 'tv_mute': {
                const mute = Boolean(a.mute);
                await tv.setMute(mute);
                return text(mute ? 'Son coupé.' : 'Son rétabli.');
            }
            case 'tv_set_input': {
                const source = String(a.source);
                await tv.setInput(source);
                return text(`Entrée changée : ${source}.`);
            }
            case 'tv_status': {
                const s = await tv.status();
                if (s.power === 'off') return text('La télé est éteinte.');
                rememberInputs(s);
                const parts = ['La télé est allumée'];
                if (s.input) parts.push(`sur ${s.input}`);
                if (typeof s.volume === 'number')
                    parts.push(`volume ${s.volume}`);
                if (s.muted) parts.push('son coupé');
                return text(parts.join(', ') + '.');
            }
            case 'tv_get_status': {
                // Statut structuré pour le dashboard (parsé en objet par callToolInner).
                const s = await tv.status();
                const inputs =
                    s.power === 'on'
                        ? rememberInputs(s)
                        : inputCatalog(loadTvConfig());
                const { supportedInputs: _sup, ...rest } = s;
                return text(JSON.stringify({ ...rest, inputs }));
            }
            default:
                throw new McpError(
                    ErrorCode.MethodNotFound,
                    `Unknown tool: ${name}`,
                );
        }
    } catch (error) {
        if (error instanceof McpError) throw error;
        if (error instanceof TvOfflineError)
            return { ...text('La télé est éteinte.'), isError: true };
        const message = error instanceof Error ? error.message : String(error);
        Logger.error(`Tool "${name}" error: ${message}`);
        return { ...text(`Erreur : ${message}`), isError: true };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-smartthings server running on stdio');
}

main().catch((err) => {
    Logger.error(`Fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
