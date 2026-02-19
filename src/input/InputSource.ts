export type StreamHandler = (
    order: string,
) => AsyncGenerator<string, void, unknown>;

export type StatusHandler = () => object;

export interface InputSource {
    start(
        handler: (order: string) => Promise<string>,
        streamHandler?: StreamHandler,
        statusHandler?: StatusHandler,
    ): Promise<void>;
    stop(): Promise<void>;
}
