export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type Order = {
    content: string;
    timestamp: string;
};

export interface StoryMessage {
    role: Role;
    content?: string;
    timestamp?: number;
    toolCallId?: string;
    toolName?: string;
}
