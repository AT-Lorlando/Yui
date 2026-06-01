export type StreamOptions = {
    /** Cap the LLM response length. Use ~80 for voice, undefined for text. */
    maxTokens?: number;
    /** Output channel for automations created during this request. */
    outputChannel?: import('../orchestrator/automations').OutputChannel;
    /** Id d'une conversation app à continuer/reprendre. */
    conversationId?: string;
    /** Force le chemin "app" même sans id (nouvelle conversation app). */
    appConversation?: boolean;
    /** Callback : id de la conversation utilisée (émis en 1er event SSE). */
    onConversationId?: (id: string) => void;
};

export type StreamHandler = (
    order: string,
    options?: StreamOptions,
    reset?: boolean,
) => AsyncGenerator<string, void, unknown>;

export type StatusHandler = () => object;

export type DeviceHandler = (
    toolName: string,
    args: Record<string, unknown>,
) => Promise<unknown>;

export interface ScenesHandler {
    list: () => import('../orchestrator/scenes').Scene[];
    trigger: (id: string) => Promise<{ success: boolean; error?: string }>;
    create: (
        data: import('../orchestrator/scenes').CreateSceneInput,
    ) => import('../orchestrator/scenes').Scene;
    update: (
        id: string,
        input: Partial<import('../orchestrator/scenes').CreateSceneInput>,
    ) => import('../orchestrator/scenes').Scene | null;
    remove: (id: string) => boolean;
    toggleFavorite: (
        id: string,
    ) => import('../orchestrator/scenes').Scene | null;
}

export interface ToolsHandler {
    list: () => {
        serverName: string;
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
    }[];
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface AutomationsHandler {
    list: () => import('../orchestrator/automations').Automation[];
    add: (
        input: import('../orchestrator/automations').CreateAutomationInput,
    ) => import('../orchestrator/automations').Automation;
    update: (
        id: string,
        patch: Partial<
            Omit<
                import('../orchestrator/automations').Automation,
                'id' | 'createdAt'
            >
        >,
    ) => import('../orchestrator/automations').Automation | null;
    toggle: (id: string) => string | null;
    remove: (id: string) => boolean;
    run: (id: string) => Promise<{ success: boolean; error?: string }>;
}

export type PresenceHandler =
    () => import('../orchestrator/presence').PresenceState;

export type LocationHandler = (
    lat: number,
    lng: number,
    accuracy: number,
) => import('../orchestrator/presence').LocationResponse;

export interface ConversationsHandler {
    list: (
        scope: 'resumable' | 'all',
    ) => import('../orchestrator/storyArchive').StoryIndexEntry[];
    get: (id: string) => {
        entries: import('../orchestrator/story').StoryEntry[];
        meta?: import('../orchestrator/storyArchive').StoryIndexEntry;
        branches: import('../orchestrator/storyArchive').StoryIndexEntry[];
    };
    simulate: (
        id: string,
        body: {
            fromMessageIndex?: number;
            systemPrompt?: string;
            temperature?: number;
        },
        options: { onConversationId?: (id: string) => void },
    ) => AsyncGenerator<string, void, unknown>;
}

export interface InputSource {
    start(
        handler: (
            order: string,
            reset?: boolean,
            outputChannel?: import('../orchestrator/automations').OutputChannel,
            conversationId?: string,
        ) => Promise<string>,
        streamHandler?: StreamHandler,
        statusHandler?: StatusHandler,
        deviceHandler?: DeviceHandler,
        scenesHandler?: ScenesHandler,
        toolsHandler?: ToolsHandler,
        locationHandler?: LocationHandler,
        automationsHandler?: AutomationsHandler,
        presenceHandler?: PresenceHandler,
        conversationsHandler?: ConversationsHandler,
    ): Promise<void>;
    stop(): Promise<void>;
}
