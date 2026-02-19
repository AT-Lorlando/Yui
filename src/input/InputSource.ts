export interface InputSource {
    start(handler: (order: string) => Promise<string>): Promise<void>;
    stop(): Promise<void>;
}
