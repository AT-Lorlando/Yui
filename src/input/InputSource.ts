export type StreamHandler = (
    order: string,
) => AsyncGenerator<string, void, unknown>;

export type StatusHandler = () => object;

export type DeviceHandler = (
    toolName: string,
    args: Record<string, unknown>,
) => Promise<unknown>;

export interface InputSource {
    start(
        handler: (order: string) => Promise<string>,
        streamHandler?: StreamHandler,
        statusHandler?: StatusHandler,
        deviceHandler?: DeviceHandler,
    ): Promise<void>;
    stop(): Promise<void>;
}
