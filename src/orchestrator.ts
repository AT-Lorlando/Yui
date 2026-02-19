import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import OpenAI from 'openai';
import * as path from 'path';
import { env } from './env';
import Logger from './logger';
import { Story } from './story';
import { buildSystemPrompt } from './systemPrompt';
import {
    buildMemoryContext,
    saveMemory,
    deleteMemory,
    readNamespace,
    listNamespaces,
} from './memory';
import { buildStorySummariesContext, getStoryDetail } from './storyArchive';
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
                    name: 'get_story_detail',
                    description:
                        "Obtenir le transcript complet d'une discussion passée par son id",
                    parameters: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'string',
                                description:
                                    'ID de la discussion (visible dans les résumés)',
                            },
                        },
                        required: ['id'],
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

            case 'get_story_detail':
                return { id: toolCall.id, content: getStoryDetail(args.id) };

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
                Logger.debug(`Tool ${toolName} result: ${content}`);
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

    // ── Main entry point ─────────────────────────────────────────────────────

    async processOrder(order: string): Promise<string> {
        const story = env.SAVE_STORIES ? new Story() : null;
        story?.add({ role: 'user', content: order });

        Logger.info(`Processing order: "${order}"`);

        // Build dynamic system prompt (re-reads prompts/*.md on every call)
        const memCtx = buildMemoryContext();
        const systemPrompt = buildSystemPrompt({
            alwaysMemory: memCtx.alwaysMemory,
            onDemandNamespaces: memCtx.onDemandNamespaces,
            storySummaries: buildStorySummariesContext(order),
        });

        const allTools: OpenAI.Chat.ChatCompletionTool[] = [
            ...this.getVirtualTools(),
            ...this.collectedTools.map((ct) => ({
                type: 'function' as const,
                function: {
                    name: ct.tool.name,
                    description: ct.tool.description,
                    parameters: ct.tool.inputSchema as Record<string, unknown>,
                },
            })),
        ];

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

            for (const toolCall of assistantMessage.tool_calls) {
                // Virtual tools are handled in-process; MCP tools go to servers
                const virtualResult = await this.handleVirtualTool(toolCall);
                const result =
                    virtualResult ?? (await this.executeToolCall(toolCall));

                story?.add({
                    role: 'tool',
                    content: result.content,
                    toolCallId: result.id,
                    toolName: toolCall.function.name,
                });

                messages.push({
                    role: 'tool',
                    tool_call_id: result.id,
                    content: result.content,
                });
            }
        }

        if (!finalResponse) finalResponse = 'Tâche effectuée.';

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
    ): AsyncGenerator<string, void, unknown> {
        const story = env.SAVE_STORIES ? new Story() : null;
        story?.add({ role: 'user', content: order });

        Logger.info(`Processing order (stream): "${order}"`);

        const memCtx = buildMemoryContext();
        const systemPrompt = buildSystemPrompt({
            alwaysMemory: memCtx.alwaysMemory,
            onDemandNamespaces: memCtx.onDemandNamespaces,
            storySummaries: buildStorySummariesContext(order),
        });

        const allTools: OpenAI.Chat.ChatCompletionTool[] = [
            ...this.getVirtualTools(),
            ...this.collectedTools.map((ct) => ({
                type: 'function' as const,
                function: {
                    name: ct.tool.name,
                    description: ct.tool.description,
                    parameters: ct.tool.inputSchema as Record<string, unknown>,
                },
            })),
        ];

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
                stream: true,
            });

            // Accumulate the response from streaming chunks
            let contentAcc = '';
            const toolCallsAcc = new Map<
                number,
                { id: string; name: string; arguments: string }
            >();

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;

                if (delta?.content) {
                    contentAcc += delta.content;
                    yield delta.content; // stream token to caller immediately
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
                        if (tc.id) acc.id = tc.id;
                        if (tc.function?.name) acc.name += tc.function.name;
                        if (tc.function?.arguments)
                            acc.arguments += tc.function.arguments;
                    }
                }
            }

            if (toolCallsAcc.size > 0) {
                // Tool call round — reconstruct full tool calls and execute them
                const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] =
                    Array.from(toolCallsAcc.values()).map((tc) => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: { name: tc.name, arguments: tc.arguments },
                    }));

                messages.push({
                    role: 'assistant',
                    content: contentAcc || null,
                    tool_calls: toolCalls,
                });

                for (const toolCall of toolCalls) {
                    const virtualResult = await this.handleVirtualTool(
                        toolCall,
                    );
                    const result =
                        virtualResult ?? (await this.executeToolCall(toolCall));

                    story?.add({
                        role: 'tool',
                        content: result.content,
                        toolCallId: result.id,
                        toolName: toolCall.function.name,
                    });

                    messages.push({
                        role: 'tool',
                        tool_call_id: result.id,
                        content: result.content,
                    });
                }
            } else {
                // Text response — we already yielded all tokens, just record it
                finalResponse = contentAcc;
                story?.add({ role: 'assistant', content: finalResponse });
                break;
            }
        }

        if (!finalResponse) {
            finalResponse = 'Tâche effectuée.';
            yield finalResponse;
        }

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
    }

    async shutdown(): Promise<void> {
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

    return [
        {
            name: 'mcp-hue',
            command: 'npx',
            args: ['ts-node', path.join(root, 'packages/mcp-hue/src/index.ts')],
        },
        {
            name: 'mcp-nuki',
            command: 'npx',
            args: [
                'ts-node',
                path.join(root, 'packages/mcp-nuki/src/index.ts'),
            ],
        },
        {
            name: 'mcp-spotify',
            command: 'npx',
            args: [
                'ts-node',
                path.join(root, 'packages/mcp-spotify/src/index.ts'),
            ],
        },
        {
            name: 'mcp-linear',
            command: 'npx',
            args: [
                'ts-node',
                path.join(root, 'packages/mcp-linear/src/index.ts'),
            ],
        },
        {
            name: 'mcp-samsung',
            command: 'npx',
            args: [
                'ts-node',
                path.join(root, 'packages/mcp-samsung/src/index.ts'),
            ],
        },
        {
            name: 'mcp-calendar',
            command: 'npx',
            args: [
                'ts-node',
                path.join(root, 'packages/mcp-calendar/src/index.ts'),
            ],
        },
        {
            name: 'mcp-weather',
            command: 'npx',
            args: [
                'ts-node',
                path.join(root, 'packages/mcp-weather/src/index.ts'),
            ],
        },
        {
            name: 'mcp-obsidian',
            command: 'npx',
            args: [
                'ts-node',
                path.join(root, 'packages/mcp-obsidian/src/index.ts'),
            ],
        },
        // Uncomment to enable browser server (Phase 2):
        // {
        //     name: 'mcp-browser',
        //     command: 'npx',
        //     args: ['ts-node', path.join(root, 'packages/mcp-browser/src/index.ts')],
        // },
    ];
}
