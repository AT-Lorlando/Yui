import * as fs from 'fs';
import * as path from 'path';
import Logger from '../logger';

export interface StoryEntry {
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: string;
    toolCallId?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    /** Tool names passed to the LLM for this exchange (system role only). */
    tools?: string[];
    timestamp: number;
}

export class Story {
    public readonly id: string;
    public readonly source: 'voice' | 'app';
    public readonly parentId?: string;
    public readonly entries: StoryEntry[] = [];

    constructor(opts?: {
        source?: 'voice' | 'app';
        id?: string;
        parentId?: string;
    }) {
        this.id = opts?.id ?? Date.now().toString();
        this.source = opts?.source ?? 'app';
        this.parentId = opts?.parentId;
    }

    add(entry: Omit<StoryEntry, 'timestamp'>): void {
        this.entries.push({ ...entry, timestamp: Date.now() });
    }

    /**
     * Write entries to disk. Does NOT trigger summarization — call this after
     * every exchange within a session so the file is always up to date.
     */
    flush(): void {
        try {
            const dir = 'stories';
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const filePath = path.join(dir, `story-${this.id}.json`);
            fs.writeFileSync(filePath, JSON.stringify(this.entries, null, 2));
        } catch (error) {
            Logger.error(`Failed to flush story: ${error}`);
        }
    }
}
