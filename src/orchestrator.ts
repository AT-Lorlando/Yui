import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import OpenAI from 'openai';
import * as path from 'path';
import { env } from './env';
import Logger from './logger';
import { Story } from './story';
import { buildSystemPrompt } from './systemPrompt';
import { StreamOptions } from './input/InputSource';
import {
    buildMemoryContext,
    saveMemory,
    deleteMemory,
    readNamespace,
    listNamespaces,
} from './memory';
import {
    buildStorySummariesContext,
    searchStoriesWithLLM,
    indexMissingStories,
} from './storyArchive';
import {
    addSchedule,
    listSchedules,
    deleteSchedule,
    toggleSchedule,
} from './scheduler';

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

interface ToolCallResult {
    id: string;
    content: string;
}

/** Max messages kept in the rolling conversation buffer (user + assistant pairs). */
const HISTORY_MAX = 10;

export class Orchestrator {
    private openai: OpenAI;
    private clients: Map<string, Client> = new Map();
    private collectedTools: CollectedTool[] = [];
    private servers: McpServerConfig[];
    private conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    /**
     * Persistent story that spans multiple processOrderStream calls within
     * the same voice conversation session (10 s window). Finalized (saved +
     * summarized) on reset or server shutdown.
     */
    private sessionStory: Story | null = null;

    /** Compact entity summary built at startup (rooms, doors, speakers). */
    private entitySnapshot: string = '';

    constructor(servers: McpServerConfig[]) {
        this.openai = new OpenAI({
            apiKey: env.LLM_API_KEY,
            ...(env.LLM_BASE_URL && { baseURL: env.LLM_BASE_URL }),
        });
        this.servers = servers;
    }

    async init(): Promise<void> {
        Logger.info(
            `LLM: model=${env.LLM_MODEL}` +
                (env.LLM_BASE_URL ? ` baseURL=${env.LLM_BASE_URL}` : ''),
        );
        Logger.info('Connecting to MCP servers…');
        for (const serverConfig of this.servers) {
            try {
                await this.connectServer(serverConfig);
            } catch (error) {
                Logger.error(
                    `Failed to connect to MCP server "${serverConfig.name}": ${error}`,
                );
            }
        }
        Logger.info(
            `Connected to ${this.clients.size} MCP server(s). ` +
                `Total tools available: ${this.collectedTools.length}`,
        );

        await this.refreshEntitySnapshot();

        // Index any stories written to disk but not yet summarized
        // (happens when the process is killed without a clean shutdown).
        if (env.SAVE_STORIES) {
            indexMissingStories().catch((e) =>
                Logger.warn(`Background story indexing failed: ${e}`),
            );
        }
    }

    /** Fetch entities from MCP servers and build a compact snapshot string. */
    private async refreshEntitySnapshot(): Promise<void> {
        const parts: string[] = [];

        try {
            const raw = await this.callTool('list_lights');
            const lights = Array.isArray(raw) ? raw : [];
            if (lights.length > 0) {
                const rooms = [
                    ...new Set(
                        lights
                            .map((l: any) => l.room ?? l.name)
                            .filter(Boolean),
                    ),
                ];
                parts.push(
                    `Lumières (${lights.length}) — pièces : ${rooms.join(
                        ', ',
                    )}`,
                );
            }
        } catch (e) {
            Logger.debug(`Entity snapshot: list_lights failed — ${e}`);
        }

        try {
            const raw = await this.callTool('list_doors');
            const doors = Array.isArray(raw) ? raw : [];
            if (doors.length > 0) {
                const names = doors.map((d: any) => d.name).filter(Boolean);
                parts.push(`Portes Nuki : ${names.join(', ')}`);
            }
        } catch (e) {
            Logger.debug(`Entity snapshot: list_doors failed — ${e}`);
        }

        try {
            const raw = await this.callTool('list_speakers');
            const speakers = Array.isArray(raw) ? raw : [];
            if (speakers.length > 0) {
                const names = speakers.map((s: any) => s.name).filter(Boolean);
                parts.push(`Enceintes Spotify : ${names.join(', ')}`);
            }
        } catch (e) {
            Logger.debug(`Entity snapshot: list_speakers failed — ${e}`);
        }

        this.entitySnapshot = parts.join('\n');
        if (this.entitySnapshot) {
            Logger.info(`Entity snapshot: ${this.entitySnapshot}`);
        }
    }

    private async connectServer(config: McpServerConfig): Promise<void> {
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
        });

        const client = new Client(
            { name: 'yui-orchestrator', version: '1.0.0' },
            { capabilities: {} },
        );

        await client.connect(transport);
        this.clients.set(config.name, client);

        const { tools } = await client.listTools();
        for (const tool of tools) {
            this.collectedTools.push({
                serverName: config.name,
                client,
                tool: {
                    name: tool.name,
                    description: tool.description ?? '',
                    inputSchema: tool.inputSchema as Record<string, unknown>,
                },
            });
            Logger.debug(
                `Registered tool "${tool.name}" from server "${config.name}"`,
            );
        }

        Logger.info(
            `Connected to "${config.name}" — ${tools.length} tool(s) loaded`,
        );
    }

    // ── Virtual tools ────────────────────────────────────────────────────────

    private getVirtualTools(): OpenAI.Chat.ChatCompletionTool[] {
        return [
            {
                type: 'function',
                function: {
                    name: 'memory_save',
                    description:
                        'Sauvegarder un fait en mémoire persistante (par namespace/catégorie)',
                    parameters: {
                        type: 'object',
                        properties: {
                            namespace: {
                                type: 'string',
                                description:
                                    'Catégorie (ex: personnel, musique, recettes, notes)',
                            },
                            key: {
                                type: 'string',
                                description: 'Nom/clé du fait',
                            },
                            value: {
                                type: 'string',
                                description: 'Valeur à retenir',
                            },
                            priority: {
                                type: 'string',
                                enum: ['always', 'on-demand'],
                                description:
                                    'always = injecté dans chaque prompt (petit et fréquent), on-demand = disponible sur demande (volumineux ou rare)',
                            },
                        },
                        required: ['namespace', 'key', 'value'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'memory_delete',
                    description: 'Supprimer un fait de la mémoire',
                    parameters: {
                        type: 'object',
                        properties: {
                            namespace: { type: 'string' },
                            key: { type: 'string' },
                        },
                        required: ['namespace', 'key'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'memory_read',
                    description:
                        "Lire le contenu d'un namespace mémoire (pour les namespaces on-demand)",
                    parameters: {
                        type: 'object',
                        properties: {
                            namespace: { type: 'string' },
                        },
                        required: ['namespace'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'memory_list',
                    description:
                        'Lister tous les namespaces mémoire disponibles avec leur taille',
                    parameters: { type: 'object', properties: {} },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'search_stories',
                    description:
                        'Recherche sémantique dans les discussions passées. Utilise cet outil quand Jérémy fait référence à une conversation précédente ("tu te souviens quand...", "la dernière fois qu\'on a parlé de..."). Retourne le transcript complet des discussions les plus pertinentes.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description:
                                    'Description en langage naturel de ce que tu cherches (ex: "quand j\'ai demandé d\'envoyer un email", "la discussion sur la météo d\'hier")',
                            },
                        },
                        required: ['query'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'schedule_add',
                    description:
                        'Créer une tâche planifiée (cron job) — ex: rappels, automatisations récurrentes',
                    parameters: {
                        type: 'object',
                        properties: {
                            name: {
                                type: 'string',
                                description: 'Nom lisible de la tâche',
                            },
                            cron: {
                                type: 'string',
                                description:
                                    'Expression cron (ex: "30 8 * * 1-5" = lun-ven 8h30)',
                            },
                            prompt: {
                                type: 'string',
                                description:
                                    'Ordre à envoyer à Yui quand le cron se déclenche',
                            },
                        },
                        required: ['name', 'cron', 'prompt'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'schedule_list',
                    description: 'Lister toutes les tâches planifiées',
                    parameters: { type: 'object', properties: {} },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'schedule_delete',
                    description: 'Supprimer une tâche planifiée par son id',
                    parameters: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                        },
                        required: ['id'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'schedule_toggle',
                    description:
                        'Activer ou désactiver une tâche planifiée sans la supprimer',
                    parameters: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                        },
                        required: ['id'],
                    },
                },
            },
        ];
    }

    /**
     * Handles virtual (in-process) tool calls. Returns null if the tool is
     * not virtual and should be routed to an MCP server instead.
     */
    private async handleVirtualTool(
        toolCall: OpenAI.Chat.ChatCompletionMessageToolCall,
    ): Promise<ToolCallResult | null> {
        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');

        Logger.info(`Virtual tool: ${name}(${JSON.stringify(args)})`);

        switch (name) {
            case 'memory_save':
                saveMemory(args.namespace, args.key, args.value, args.priority);
                return {
                    id: toolCall.id,
                    content: `Mémorisé : [${args.namespace}] ${args.key} = ${args.value}`,
                };

            case 'memory_delete':
                deleteMemory(args.namespace, args.key);
                return {
                    id: toolCall.id,
                    content: `Oublié : [${args.namespace}] ${args.key}`,
                };

            case 'memory_read':
                return {
                    id: toolCall.id,
                    content: readNamespace(args.namespace),
                };

            case 'memory_list':
                return { id: toolCall.id, content: listNamespaces() };

            case 'search_stories':
                return {
                    id: toolCall.id,
                    content: await searchStoriesWithLLM(args.query as string),
                };

            case 'schedule_add': {
                const result = addSchedule(args.name, args.cron, args.prompt);
                if (typeof result === 'string')
                    return { id: toolCall.id, content: result };
                return {
                    id: toolCall.id,
                    content: `Schedule "${args.name}" créé (id: ${result.id}, cron: ${result.cron})`,
                };
            }

            case 'schedule_list':
                return { id: toolCall.id, content: listSchedules() };

            case 'schedule_delete':
                return {
                    id: toolCall.id,
                    content: deleteSchedule(args.id)
                        ? `Schedule "${args.id}" supprimé.`
                        : `Schedule "${args.id}" introuvable.`,
                };

            case 'schedule_toggle':
                return { id: toolCall.id, content: toggleSchedule(args.id) };

            default:
                return null;
        }
    }

    // ── MCP tool execution ───────────────────────────────────────────────────

    private async executeToolCall(
        toolCall: OpenAI.Chat.ChatCompletionMessageToolCall,
    ): Promise<ToolCallResult> {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

        Logger.info(`Calling tool: ${toolName}(${JSON.stringify(toolArgs)})`);

        const collectedTool = this.collectedTools.find(
            (ct) => ct.tool.name === toolName,
        );

        if (!collectedTool) {
            const content = `Error: Tool "${toolName}" not found`;
            Logger.error(content);
            return { id: toolCall.id, content };
        }

        try {
            const result = await collectedTool.client.callTool({
                name: toolName,
                arguments: toolArgs,
            });

            const textContent = (
                result.content as { type: string; text: string }[]
            )
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('\n');

            const content = textContent || 'Done.';

            if (result.isError) {
                Logger.warn(`Tool ${toolName} returned an error: ${content}`);
            } else {
                const preview =
                    content.length > 300
                        ? content.slice(0, 300) + '…'
                        : content;
                Logger.info(`Tool result [${toolName}]: ${preview}`);
            }

            return { id: toolCall.id, content };
        } catch (error) {
            const content = `Error executing tool "${toolName}": ${
                error instanceof Error ? error.message : String(error)
            }`;
            Logger.error(content);
            return { id: toolCall.id, content };
        }
    }

    // ── Tool filtering ────────────────────────────────────────────────────────

    /**
     * Returns only the MCP tools relevant to the user's order, based on
     * keyword matching. Falls back to all tools if nothing matches so the LLM
     * always has a way to respond.
     *
     * This is the biggest latency lever: reducing from 67 → ~10 tools cuts
     * input tokens by ~60-70%, which directly lowers TTFT on every LLM call.
     */
    private filterToolsForOrder(order: string): CollectedTool[] {
        const SERVER_KEYWORDS: Record<string, string[]> = {
            'mcp-hue': [
                'lumière',
                'lampe',
                'allume',
                'éteins',
                'éclairage',
                'luminosité',
                'couleur',
                'light',
                'lamp',
                'chambre',
                'salon',
                'cuisine',
                'bureau',
                'salle',
                'ambiance',
                'bright',
                'dim',
            ],
            'mcp-nuki': [
                'porte',
                'verrou',
                'clé',
                'ferme',
                'ouvre',
                'lock',
                'door',
            ],
            'mcp-spotify': [
                'musique',
                'spotify',
                'joue',
                'chanson',
                'playlist',
                'album',
                'artiste',
                'écoute',
                'volume',
                'pause',
                'music',
                'son',
                'radio',
                'morceau',
                'track',
                'shuffle',
                'repeat',
            ],
            'mcp-linear': [
                'linear',
                'ticket',
                'issue',
                'tâche',
                'projet',
                'koya',
                'bug',
            ],
            'mcp-samsung': [
                'tv',
                'télé',
                'télévision',
                'samsung',
                'écran',
                'hdmi',
                'cinéma',
                'film',
                'série',
            ],
            'mcp-calendar': [
                'calendrier',
                'agenda',
                'réunion',
                'rendez-vous',
                'événement',
                'planning',
                'semaine',
                'demain',
                'lundi',
                'mardi',
                'mercredi',
                'jeudi',
                'vendredi',
                'samedi',
                'dimanche',
                'aujourd',
                'mois',
            ],
            'mcp-weather': [
                'météo',
                'temps',
                'température',
                'pluie',
                'soleil',
                'vent',
                'chaud',
                'froid',
                'nuage',
                'weather',
                'demain',
                'prévision',
                'semaine prochaine',
                'après-demain',
                'forecast',
            ],
            'mcp-obsidian': [
                'note',
                'obsidian',
                'fichier',
                'document',
                'écris',
                'journal',
                'vault',
            ],
            'mcp-gmail': [
                'email',
                'mail',
                'gmail',
                'message',
                'inbox',
                'boîte',
                'envoie',
                'reçu',
                'expéditeur',
                'destinataire',
                'objet',
                'pièce jointe',
                'brouillon',
                'archive',
                'corbeille',
                'non lu',
                'marque',
            ],
        };

        const lc = order.toLowerCase();
        const relevantServers = new Set<string>();
        for (const [server, keywords] of Object.entries(SERVER_KEYWORDS)) {
            if (keywords.some((kw) => lc.includes(kw))) {
                relevantServers.add(server);
            }
        }

        // No keyword matched → generic/unknown request, send everything
        if (relevantServers.size === 0) {
            Logger.debug(
                `Tool filter: no match — sending all ${this.collectedTools.length} tools`,
            );
            return this.collectedTools;
        }

        const filtered = this.collectedTools.filter((ct) =>
            relevantServers.has(ct.serverName),
        );
        Logger.debug(
            `Tool filter: [${[...relevantServers].join(', ')}] → ${
                filtered.length
            }/${this.collectedTools.length} tools`,
        );
        return filtered;
    }

    // ── Main entry point ─────────────────────────────────────────────────────

    async processOrder(order: string, reset?: boolean): Promise<string> {
        if (reset) {
            this.conversationHistory = [];
            Logger.info('Conversation history reset (new conversation)');
        }

        const story = env.SAVE_STORIES ? new Story() : null;

        Logger.info(`Processing order: "${order}"`);

        // Build dynamic system prompt (re-reads prompts/*.md on every call)
        const memCtx = buildMemoryContext();
        const systemPrompt = buildSystemPrompt({
            alwaysMemory: memCtx.alwaysMemory,
            onDemandNamespaces: memCtx.onDemandNamespaces,
            storySummaries: buildStorySummariesContext(),
            entities: this.entitySnapshot || undefined,
        });

        const allTools: OpenAI.Chat.ChatCompletionTool[] = [
            ...this.getVirtualTools(),
            ...this.filterToolsForOrder(order).map((ct) => ({
                type: 'function' as const,
                function: {
                    name: ct.tool.name,
                    description: ct.tool.description,
                    parameters: ct.tool.inputSchema as Record<string, unknown>,
                },
            })),
        ];

        story?.add({
            role: 'system',
            content: systemPrompt,
            tools: allTools.map((t) => t.function.name),
        });
        story?.add({ role: 'user', content: order });

        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            ...this.conversationHistory,
            { role: 'user', content: order },
        ];

        const MAX_TURNS = 10;
        let finalResponse = '';

        for (let turn = 0; turn < MAX_TURNS; turn++) {
            Logger.debug(`LLM turn ${turn + 1}/${MAX_TURNS}`);

            const response = await this.openai.chat.completions.create({
                model: env.LLM_MODEL,
                messages,
                tools: allTools.length > 0 ? allTools : undefined,
                tool_choice: allTools.length > 0 ? 'auto' : undefined,
                temperature: 0,
            });

            const choice = response.choices[0];
            const assistantMessage = choice.message;
            messages.push(assistantMessage);

            if (
                choice.finish_reason === 'stop' ||
                !assistantMessage.tool_calls
            ) {
                finalResponse = assistantMessage.content ?? '';
                story?.add({ role: 'assistant', content: finalResponse });
                break;
            }

            // Execute all tool calls in parallel — independent tools (lights, music,
            // doors, etc.) don't need to wait for each other.
            const toolResults = await Promise.all(
                assistantMessage.tool_calls.map(async (toolCall) => {
                    const virtualResult = await this.handleVirtualTool(
                        toolCall,
                    );
                    const result =
                        virtualResult ?? (await this.executeToolCall(toolCall));
                    const args = JSON.parse(
                        toolCall.function.arguments || '{}',
                    ) as Record<string, unknown>;
                    return { toolName: toolCall.function.name, result, args };
                }),
            );
            for (const { toolName, result, args } of toolResults) {
                story?.add({
                    role: 'tool',
                    content: result.content,
                    toolCallId: result.id,
                    toolName,
                    toolArgs: args,
                });
                messages.push({
                    role: 'tool',
                    tool_call_id: result.id,
                    content: result.content,
                });
            }
        }

        if (!finalResponse) finalResponse = 'Tâche effectuée.';

        const preview =
            finalResponse.length > 300
                ? finalResponse.slice(0, 300) + '…'
                : finalResponse;
        Logger.info(`[Response] ${preview}`);

        // Update rolling conversation history
        this.conversationHistory.push({ role: 'user', content: order });
        this.conversationHistory.push({
            role: 'assistant',
            content: finalResponse,
        });
        if (this.conversationHistory.length > HISTORY_MAX) {
            this.conversationHistory.splice(
                0,
                this.conversationHistory.length - HISTORY_MAX,
            );
        }

        story?.save();
        return finalResponse;
    }

    /**
     * Streaming variant of processOrder. Tool-call rounds are still blocking
     * (we must receive the full tool call before executing it), but the final
     * text response is yielded token-by-token as the LLM generates it, so the
     * caller can start TTS on the first sentence before the full response is
     * ready.
     */
    async *processOrderStream(
        order: string,
        options?: StreamOptions,
        reset?: boolean,
    ): AsyncGenerator<string, void, unknown> {
        if (reset) {
            // Finalize the previous session story (triggers summarization)
            if (this.sessionStory) {
                this.sessionStory.save();
                this.sessionStory = null;
                Logger.info('Previous session story finalized');
            }
            this.conversationHistory = [];
            Logger.info(
                'Conversation history reset (new conversation, stream)',
            );
        }

        // Reuse or create the session story for this conversation window
        if (env.SAVE_STORIES && !this.sessionStory) {
            this.sessionStory = new Story();
            Logger.info(`Session story started: story-${this.sessionStory.id}`);
        }
        const story = this.sessionStory;

        Logger.info(`Processing order (stream): "${order}"`);

        const memCtx = buildMemoryContext();
        const systemPrompt = buildSystemPrompt({
            alwaysMemory: memCtx.alwaysMemory,
            onDemandNamespaces: memCtx.onDemandNamespaces,
            storySummaries: buildStorySummariesContext(),
            entities: this.entitySnapshot || undefined,
        });

        // Build filter context: current order + all previous user messages in the
        // session so follow-up phrases like "laisse tomber" or "annule" still have
        // access to the same tools as the earlier exchange they refer to.
        const sessionContext =
            this.sessionStory?.entries
                .filter((e) => e.role === 'user')
                .map((e) => e.content)
                .join(' ') ?? '';
        const filterInput = sessionContext
            ? `${sessionContext} ${order}`
            : order;

        const allTools: OpenAI.Chat.ChatCompletionTool[] = [
            ...this.getVirtualTools(),
            ...this.filterToolsForOrder(filterInput).map((ct) => ({
                type: 'function' as const,
                function: {
                    name: ct.tool.name,
                    description: ct.tool.description,
                    parameters: ct.tool.inputSchema as Record<string, unknown>,
                },
            })),
        ];

        story?.add({
            role: 'system',
            content: systemPrompt,
            tools: allTools.map((t) => t.function.name),
        });
        story?.add({ role: 'user', content: order });

        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            ...this.conversationHistory,
            { role: 'user', content: order },
        ];

        const MAX_TURNS = 10;
        let finalResponse = '';

        for (let turn = 0; turn < MAX_TURNS; turn++) {
            Logger.debug(`LLM turn ${turn + 1}/${MAX_TURNS} (stream)`);

            const stream = await this.openai.chat.completions.create({
                model: env.LLM_MODEL,
                messages,
                tools: allTools.length > 0 ? allTools : undefined,
                tool_choice: allTools.length > 0 ? 'auto' : undefined,
                temperature: 0,
                stream: true,
                ...(options?.maxTokens
                    ? { max_tokens: options.maxTokens }
                    : {}),
            });

            // Accumulate the response from streaming chunks.
            // Tokens are buffered and NOT yielded yet — we must first confirm
            // this is the final text turn (no tool calls). If the LLM emits
            // content alongside tool calls (Kimi K2 / DeepSeek do this), we
            // must discard that content so TTS doesn't speak before tools run.
            let contentAcc = '';
            const tokenBuffer: string[] = [];
            const toolCallsAcc = new Map<
                number,
                { id: string; name: string; arguments: string }
            >();

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;

                if (delta?.content) {
                    contentAcc += delta.content;
                    tokenBuffer.push(delta.content); // buffer — don't yield yet
                }

                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (!toolCallsAcc.has(tc.index)) {
                            toolCallsAcc.set(tc.index, {
                                id: tc.id ?? '',
                                name: tc.function?.name ?? '',
                                arguments: '',
                            });
                        }
                        const acc = toolCallsAcc.get(tc.index)!;
                        if (tc.id && !acc.id) acc.id = tc.id; // only set once
                        if (tc.function?.name && !acc.name)
                            acc.name = tc.function.name;
                        if (tc.function?.arguments)
                            acc.arguments += tc.function.arguments;
                    }
                }
            }

            if (toolCallsAcc.size > 0) {
                // Tool call round — reconstruct full tool calls and execute them.
                // Any content the LLM emitted alongside tool calls is discarded
                // (it's reasoning/preamble text, not the final spoken response).
                const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] =
                    Array.from(toolCallsAcc.values()).map((tc) => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: { name: tc.name, arguments: tc.arguments },
                    }));

                messages.push({
                    role: 'assistant',
                    content: null, // discard any tool-round preamble text
                    tool_calls: toolCalls,
                });

                // Execute all tool calls in parallel
                const toolResults = await Promise.all(
                    toolCalls.map(async (toolCall) => {
                        const virtualResult = await this.handleVirtualTool(
                            toolCall,
                        );
                        const result =
                            virtualResult ??
                            (await this.executeToolCall(toolCall));
                        const args = JSON.parse(
                            toolCall.function.arguments || '{}',
                        ) as Record<string, unknown>;
                        return {
                            toolName: toolCall.function.name,
                            result,
                            args,
                        };
                    }),
                );
                for (const { toolName, result, args } of toolResults) {
                    story?.add({
                        role: 'tool',
                        content: result.content,
                        toolCallId: result.id,
                        toolName,
                        toolArgs: args,
                    });
                    messages.push({
                        role: 'tool',
                        tool_call_id: result.id,
                        content: result.content,
                    });
                }
            } else {
                // Final text response — now yield the buffered tokens
                for (const token of tokenBuffer) {
                    yield token;
                }
                finalResponse = contentAcc;
                story?.add({ role: 'assistant', content: finalResponse });
                break;
            }
        }

        if (!finalResponse) {
            finalResponse = 'Tâche effectuée.';
            yield finalResponse;
        }

        const preview =
            finalResponse.length > 300
                ? finalResponse.slice(0, 300) + '…'
                : finalResponse;
        Logger.info(`[Response] ${preview}`);

        // Update rolling conversation history
        this.conversationHistory.push({ role: 'user', content: order });
        this.conversationHistory.push({
            role: 'assistant',
            content: finalResponse,
        });
        if (this.conversationHistory.length > HISTORY_MAX) {
            this.conversationHistory.splice(
                0,
                this.conversationHistory.length - HISTORY_MAX,
            );
        }

        // Flush to disk after every exchange — session stays open for continuation.
        // The story is finalized (summarized) when the next reset arrives or on shutdown.
        story?.flush();
    }

    /** Directly calls an MCP tool by name, bypassing the LLM. Used by the /devices REST API. */
    async callTool(
        toolName: string,
        args: Record<string, unknown> = {},
    ): Promise<unknown> {
        const collectedTool = this.collectedTools.find(
            (ct) => ct.tool.name === toolName,
        );
        if (!collectedTool) throw new Error(`Tool "${toolName}" not found`);

        const result = await collectedTool.client.callTool({
            name: toolName,
            arguments: args,
        });

        const textContent = (result.content as { type: string; text: string }[])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');

        try {
            return textContent ? JSON.parse(textContent) : null;
        } catch {
            return textContent || null;
        }
    }

    /** Returns connected MCP servers and tool counts for the dashboard. */
    getStatus(): {
        servers: { name: string; tools: number }[];
        totalTools: number;
    } {
        const map = new Map<string, number>();
        for (const ct of this.collectedTools) {
            map.set(ct.serverName, (map.get(ct.serverName) ?? 0) + 1);
        }
        const servers = Array.from(map.entries()).map(([name, tools]) => ({
            name,
            tools,
        }));
        return { servers, totalTools: this.collectedTools.length };
    }

    /** Returns all collected tools with their schemas, grouped by server. */
    getTools(): {
        serverName: string;
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
    }[] {
        return this.collectedTools.map((ct) => ({
            serverName: ct.serverName,
            name: ct.tool.name,
            description: ct.tool.description,
            inputSchema: ct.tool.inputSchema,
        }));
    }

    async shutdown(): Promise<void> {
        if (this.sessionStory) {
            this.sessionStory.save();
            this.sessionStory = null;
            Logger.info('Session story finalized on shutdown');
        }

        for (const [name, client] of this.clients.entries()) {
            try {
                await client.close();
                Logger.debug(`Disconnected from MCP server "${name}"`);
            } catch (error) {
                Logger.warn(`Error closing client "${name}": ${error}`);
            }
        }
        this.clients.clear();
        this.collectedTools = [];
    }
}

export function buildServerConfigs(): McpServerConfig[] {
    const root = path.resolve(__dirname, '..');

    // In production (compiled dist/main.js) use pre-built node packages to avoid
    // ts-node compilation overhead (~2-3s × 8 servers = ~20s extra cold start).
    // In dev (ts-node src/main.ts) use ts-node so changes are picked up immediately.
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
        mcp('mcp-calendar'),
        mcp('mcp-weather'),
        mcp('mcp-obsidian'),
        mcp('mcp-gmail'),
        // mcp('mcp-browser'), // Phase 2
    ];
}
