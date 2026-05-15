export type Category = 'router' | 'light' | 'browser' | 'general';
export type Role = 'system' | 'user' | 'assistant';

export interface Response {
    status: string;
    message: string;
    content?: any;
}

export type Order = {
    content: string;
    timestamp: string;
    // room ?
};

export interface SystemOutput {
    name: string;
    entities: number[];
    success: boolean;
    error?: string;
}

export interface Command {
    name: string;
    entities?: number[];
    parameters?: Record<string, unknown>;
}

export type StoryMessage = {
    role: Role;
    content?: string;
    timestamp?: number;
    commands?: Command[];
    output?: SystemOutput[];
};

export interface LlmRouterQuery {
    category: Category;
    order: string;
}

export interface LlmRouterResponse {
    queries: LlmRouterQuery[];
}

export interface LlmResponse {
    commands: Command[];
}
