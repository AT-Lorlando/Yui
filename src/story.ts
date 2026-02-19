import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';
import { summarizeAndIndex } from './storyArchive';

export interface StoryEntry {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    toolName?: string;
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

    save(): void {
        try {
            const dir = 'stories';
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const filePath = path.join(dir, `story-${this.id}.json`);
            fs.writeFileSync(filePath, JSON.stringify(this.entries, null, 2));
            Logger.debug(`Story saved to ${filePath}`);

            // Async summarization — fire and forget, does not block the response
            summarizeAndIndex(this.id, this.entries).catch((err) =>
                Logger.warn(`Story summarization failed: ${err}`),
            );
        } catch (error) {
            Logger.error(`Failed to save story: ${error}`);
        }
    }
}
