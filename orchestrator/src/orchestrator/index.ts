import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import OpenAI from 'openai';
import { env } from '../env';
import Logger from '../logger';
import { Story } from './story';
import { buildSystemPrompt } from './systemPrompt';
import { StreamOptions } from '../input/InputSource';
import { buildMemoryContext } from './memory';
import {
    buildStorySummariesContext,
    indexMissingStories,
} from './storyArchive';
import { resolveGroups, filterToolsForOrder } from './serverGroups';
import {
    getVirtualTools,
    handleVirtualTool,
    ToolCallResult,
} from './virtualTools';
import { runScene } from './scenes';
import type { McpServerConfig, CollectedTool } from './types';
import {
    formatLights,
    formatDoors,
    formatPlayback,
    formatTv,
    formatCovers,
    buildDeviceStateSnapshot,
} from './deviceState';

export type { McpServerConfig, CollectedTool };
export { buildServerConfigs, LLM_HIDDEN_TOOLS } from './serverConfigs';
import { LLM_HIDDEN_TOOLS } from './serverConfigs';

/** Max messages kept in the rolling conversation buffer (user + assistant pairs). */
const HISTORY_MAX = 10;

/**
 * Strips markdown syntax and emojis from a TTS-bound response.
 * The LLM is instructed not to use markdown, but this is a safety net
 * in case it ignores the rule (e.g. after a model update).
 */
function stripMarkdownForTts(text: string): string {
    return (
        text
            // Bold / italic: **text**, *text*, __text__, _text_
            .replace(/\*\*(.+?)\*\*/gs, '$1')
            .replace(/\*(.+?)\*/gs, '$1')
            .replace(/__(.+?)__/gs, '$1')
            .replace(/_(.+?)_/gs, '$1')
            // Headings: # ## ###
            .replace(/^#{1,6}\s+/gm, '')
            // Bullet lists: - item, * item (start of line)
            .replace(/^[\s]*[-*]\s+/gm, '')
            // Numbered lists: 1. 2. etc
            .replace(/^\s*\d+\.\s+/gm, '')
            // Backticks: `code` and ```blocks```
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`(.+?)`/g, '$1')
            // Hex color codes like #2E8B57 (not useful orally)
            .replace(/#[0-9A-Fa-f]{6}\b/g, '')
            // Emojis (broad unicode range)
            .replace(
                /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}]/gu,
                '',
            )
            // Collapse multiple blank lines to one
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    );
}

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

    /** Snapshot near-live de l'état des appareils, rafraîchi en fond. */
    private deviceStateSnapshot: string = '';
    private deviceStateTimer?: NodeJS.Timeout;

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

        await this.refreshDeviceState();
        const refreshMs = Number(process.env.DEVICE_STATE_REFRESH_MS ?? 30000);
        this.deviceStateTimer = setInterval(() => {
            this.refreshDeviceState().catch((e) =>
                Logger.warn(`device state refresh failed: ${e}`),
            );
        }, refreshMs);
        this.deviceStateTimer.unref?.();

        // Index any stories written to disk but not yet summarized
        // (happens when the process is killed without a clean shutdown).
        if (env.SAVE_STORIES) {
            indexMissingStories().catch((e) =>
                Logger.warn(`Background story indexing failed: ${e}`),
            );
        }
    }

    /** Appelle un outil MCP avec un timeout court ; renvoie null en cas d'échec/timeout. */
    private async callToolTimed(
        name: string,
        ms = 1500,
    ): Promise<unknown | null> {
        try {
            return await Promise.race([
                this.callTool(name),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), ms),
                ),
            ]);
        } catch (e) {
            Logger.debug(`deviceState: ${name} indisponible — ${e}`);
            return null;
        }
    }

    /** Interroge l'état réel des appareils (en parallèle) et met à jour le snapshot. */
    private async refreshDeviceState(): Promise<void> {
        const [lights, doors, playback, covers] = await Promise.all([
            this.callToolTimed('list_lights'),
            this.callToolTimed('list_doors'),
            this.callToolTimed('get_playback_state'),
            this.callToolTimed('list_covers'),
        ]);

        this.deviceStateSnapshot = buildDeviceStateSnapshot([
            formatLights(lights),
            formatDoors(doors),
            formatPlayback(playback),
            formatTv(null),
            formatCovers(covers),
        ]);

        if (this.deviceStateSnapshot) {
            Logger.info(`Device state:\n${this.deviceStateSnapshot}`);
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

    // ── Helpers ──────────────────────────────────────────────────────────────

    private buildContext(order: string): {
        tools: OpenAI.Chat.ChatCompletionTool[];
        activeGroups: string[];
    } {
        const groups = resolveGroups(order);
        const activeGroups = groups.map((g) => g.name);
        const tools = [
            ...getVirtualTools(),
            ...filterToolsForOrder(order, this.collectedTools, groups)
                .filter((ct) => !LLM_HIDDEN_TOOLS.has(ct.tool.name))
                .map((ct) => ({
                    type: 'function' as const,
                    function: {
                        name: ct.tool.name,
                        description: ct.tool.description,
                        parameters: ct.tool.inputSchema as Record<
                            string,
                            unknown
                        >,
                    },
                })),
        ];
        return { tools, activeGroups };
    }

    private async runToolCalls(
        toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
        story: Story | null,
        messages: OpenAI.Chat.ChatCompletionMessageParam[],
        outputChannel: import('./automations').OutputChannel = 'cast',
    ): Promise<void> {
        const sceneRunner = (id: string) =>
            runScene(id, (tool, args) => this.callTool(tool, args));

        const toolResults = await Promise.all(
            toolCalls.map(async (toolCall) => {
                const virtualResult = await handleVirtualTool(
                    toolCall,
                    sceneRunner,
                    outputChannel,
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

    private updateHistory(order: string, response: string): void {
        this.conversationHistory.push({ role: 'user', content: order });
        this.conversationHistory.push({ role: 'assistant', content: response });
        if (this.conversationHistory.length > HISTORY_MAX) {
            this.conversationHistory.splice(
                0,
                this.conversationHistory.length - HISTORY_MAX,
            );
        }
    }

    private buildSystemPrompt(activeGroups: string[] = []): string {
        const memCtx = buildMemoryContext();
        return buildSystemPrompt({
            alwaysMemory: memCtx.alwaysMemory,
            onDemandNamespaces: memCtx.onDemandNamespaces,
            storySummaries: buildStorySummariesContext(),
            deviceState: this.deviceStateSnapshot || undefined,
            activeGroups,
        });
    }

    // ── Main entry point ─────────────────────────────────────────────────────

    /**
     * Appel LLM borné, sans tools — pour la formulation proactive et les digests.
     * Garantit que le chemin proactif ne peut ni agir ni halluciner une action.
     */
    async complete(system: string, user: string): Promise<string> {
        const response = await this.openai.chat.completions.create({
            model: env.LLM_MODEL,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        });
        return response.choices[0]?.message?.content?.trim() ?? '';
    }

    async processOrder(
        order: string,
        reset?: boolean,
        outputChannel: import('./automations').OutputChannel = 'cast',
    ): Promise<string> {
        if (reset) {
            this.conversationHistory = [];
            Logger.info('Conversation history reset (new conversation)');
        }

        const story = env.SAVE_STORIES ? new Story() : null;
        Logger.info(`Processing order: "${order}"`);

        const { tools: allTools, activeGroups } = this.buildContext(order);
        const systemPrompt = this.buildSystemPrompt(activeGroups);

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
                finalResponse = stripMarkdownForTts(
                    assistantMessage.content ?? '',
                );
                story?.add({ role: 'assistant', content: finalResponse });
                break;
            }

            await this.runToolCalls(
                assistantMessage.tool_calls,
                story,
                messages,
                outputChannel,
            );
        }

        if (!finalResponse) finalResponse = 'Tâche effectuée.';

        const preview =
            finalResponse.length > 300
                ? finalResponse.slice(0, 300) + '…'
                : finalResponse;
        Logger.info(`[Response] ${preview}`);

        this.updateHistory(order, finalResponse);
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
        outputChannel: import('./automations').OutputChannel = 'cast',
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

        const { tools: allTools, activeGroups } =
            this.buildContext(filterInput);
        const systemPrompt = this.buildSystemPrompt(activeGroups);

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
                        if (tc.id && !acc.id) acc.id = tc.id;
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

                await this.runToolCalls(
                    toolCalls,
                    story,
                    messages,
                    outputChannel,
                );
            } else {
                // Final text response — strip markdown then yield
                finalResponse = stripMarkdownForTts(contentAcc);
                yield finalResponse;
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

        this.updateHistory(order, finalResponse);

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
