import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';
import { summarizeAndIndex } from './storyArchive';

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
    public readonly entries: StoryEntry[] = [];

    constructor() {
        this.id = Date.now().toString();
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

    /**
     * Flush to disk and trigger async LLM summarization. Call this once at
     * the end of a session (on reset or shutdown).
     */
    save(): void {
        this.flush();
        Logger.debug(
            `Story saved: story-${this.id}.json (${this.entries.length} entries)`,
        );

        // Async summarization — fire and forget, does not block the response
        summarizeAndIndex(this.id, this.entries).catch((err) =>
            Logger.warn(`Story summarization failed: ${err}`),
        );
    }
}
