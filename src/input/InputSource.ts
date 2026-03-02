export type StreamOptions = {
    /** Cap the LLM response length. Use ~80 for voice, undefined for text. */
    maxTokens?: number;
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
    remove: (id: string) => boolean;
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

export interface InputSource {
    start(
        handler: (order: string, reset?: boolean) => Promise<string>,
        streamHandler?: StreamHandler,
        statusHandler?: StatusHandler,
        deviceHandler?: DeviceHandler,
        scenesHandler?: ScenesHandler,
        toolsHandler?: ToolsHandler,
    ): Promise<void>;
    stop(): Promise<void>;
}
