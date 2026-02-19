import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { env } from './env';
import Logger from './logger';
import { StoryEntry } from './story';

const INDEX_FILE = path.resolve(process.cwd(), 'data/story-index.json');
const STORIES_DIR = path.resolve(process.cwd(), 'stories');
const MAX_INDEX_SIZE = 200;

export interface StoryIndexEntry {
    id: string;
    date: string;
    summary: string;
}

function ensureDataDir(): void {
    const dir = path.dirname(INDEX_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadIndex(): StoryIndexEntry[] {
    try {
        if (!fs.existsSync(INDEX_FILE)) return [];
        return JSON.parse(
            fs.readFileSync(INDEX_FILE, 'utf-8'),
        ) as StoryIndexEntry[];
    } catch {
        return [];
    }
}

function saveIndex(index: StoryIndexEntry[]): void {
    ensureDataDir();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

/**
 * Called after a story is saved. Generates a one-sentence summary via LLM
 * and stores it in data/story-index.json.
 */
export async function summarizeAndIndex(
    storyId: string,
    entries: StoryEntry[],
): Promise<void> {
    try {
        const transcript = entries
            .filter((e) => e.role === 'user' || e.role === 'assistant')
            .map((e) => `${e.role === 'user' ? 'Jérémy' : 'Yui'}: ${e.content}`)
            .join('\n');

        if (!transcript.trim()) return;

        const openai = new OpenAI({
            apiKey: env.LLM_API_KEY,
            ...(env.LLM_BASE_URL && { baseURL: env.LLM_BASE_URL }),
        });

        const response = await openai.chat.completions.create({
            model: env.LLM_MODEL,
            messages: [
                {
                    role: 'system',
                    content:
                        'Résume cette conversation en une seule phrase concise (max 120 caractères). ' +
                        "Mentionne l'action principale et le sujet. " +
                        'Réponds uniquement avec la phrase, sans ponctuation finale.',
                },
                { role: 'user', content: transcript },
            ],
            max_tokens: 80,
        });

        const summary = response.choices[0].message.content?.trim() ?? '';
        if (!summary) return;

        const index = loadIndex();
        const entry: StoryIndexEntry = {
            id: storyId,
            date: new Date(parseInt(storyId)).toISOString().split('T')[0],
            summary,
        };

        const existing = index.findIndex((e) => e.id === storyId);
        if (existing >= 0) {
            index[existing] = entry;
        } else {
            index.push(entry);
        }

        // Keep only the most recent stories
        if (index.length > MAX_INDEX_SIZE) {
            index.splice(0, index.length - MAX_INDEX_SIZE);
        }

        saveIndex(index);
        Logger.debug(`Story ${storyId} indexed: "${summary}"`);
    } catch (err) {
        Logger.warn(`Failed to summarize story ${storyId}: ${err}`);
    }
}

/**
 * Scores relevance of a story summary against the current user order
 * using simple word overlap (no external deps, low latency).
 */
function scoreRelevance(order: string, summary: string): number {
    const words = order
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
    const lc = summary.toLowerCase();
    return words.filter((w) => lc.includes(w)).length;
}

export function findRelevantStories(order: string, n = 3): StoryIndexEntry[] {
    const index = loadIndex();
    return index
        .map((entry) => ({
            entry,
            score: scoreRelevance(order, entry.summary),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
        .map(({ entry }) => entry);
}

export function getStoryDetail(storyId: string): string {
    const filePath = path.join(STORIES_DIR, `story-${storyId}.json`);
    try {
        if (!fs.existsSync(filePath))
            return `Discussion "${storyId}" introuvable.`;
        const entries: StoryEntry[] = JSON.parse(
            fs.readFileSync(filePath, 'utf-8'),
        );
        return entries
            .filter((e) => e.role === 'user' || e.role === 'assistant')
            .map((e) => `${e.role === 'user' ? 'Jérémy' : 'Yui'}: ${e.content}`)
            .join('\n');
    } catch {
        return `Erreur lors de la lecture de la discussion "${storyId}".`;
    }
}

/**
 * Returns a formatted string of relevant story summaries for injection
 * into the system prompt. Returns empty string if none are relevant.
 */
export function buildStorySummariesContext(order: string): string {
    const relevant = findRelevantStories(order);
    if (relevant.length === 0) return '';
    return relevant
        .map((e) => `- [${e.date}] ${e.summary} (id: ${e.id})`)
        .join('\n');
}
