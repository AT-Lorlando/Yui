export type StreamHandler = (
    order: string,
) => AsyncGenerator<string, void, unknown>;

export interface InputSource {
    start(
        handler: (order: string) => Promise<string>,
        streamHandler?: StreamHandler,
    ): Promise<void>;
    stop(): Promise<void>;
}
