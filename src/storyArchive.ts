import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { env } from './env';
import Logger from './logger';
import { StoryEntry } from './story';

const INDEX_FILE = path.resolve(process.cwd(), 'data/story-index.json');
const STORIES_DIR = path.resolve(process.cwd(), 'stories');
const MAX_INDEX_SIZE = 200;

/** Tool names that indicate a home-automation (domotics) story. */
const DOMOTICS_TOOLS = new Set([
    // Hue lights
    'list_lights',
    'turn_on_light',
    'turn_off_light',
    'set_brightness',
    'set_color',
    'refresh_lights',
    'set_room_lights',
    'turn_on_all_lights',
    'turn_off_all_lights',
    // Nuki doors
    'list_doors',
    'lock_door',
    'unlock_door',
    'get_door_state',
    'refresh_doors',
    'control_door',
    // Spotify
    'list_speakers',
    'play_music',
    'pause_music',
    'next_track',
    'previous_track',
    'set_volume',
    'get_playback_state',
    'search_music',
    'refresh_speakers',
    'play_album',
    'play_playlist',
    'play_artist_radio',
    'set_shuffle',
    'set_repeat',
    'add_to_queue',
    'get_my_playlists',
    // Samsung TV
    'tv_get_status',
    'tv_power',
    'tv_set_volume',
    'tv_mute',
    'tv_set_input',
    'tv_prepare_chromecast',
    'tv_launch_app',
]);

function isDomotics(entries: StoryEntry[]): boolean {
    return entries.some(
        (e) =>
            e.role === 'tool' &&
            e.toolName !== undefined &&
            DOMOTICS_TOOLS.has(e.toolName),
    );
}

export interface StoryIndexEntry {
    id: string;
    date: string;
    summary: string;
    /** True when the story mainly involved home-automation tool calls. */
    domotics?: boolean;
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

function makeOpenAI(): OpenAI {
    return new OpenAI({
        apiKey: env.LLM_API_KEY,
        ...(env.LLM_BASE_URL && { baseURL: env.LLM_BASE_URL }),
    });
}

// ── Summarization ─────────────────────────────────────────────────────────────

/**
 * Called after a story is saved. Generates a short (10-15 word) summary via
 * LLM and stores it in data/story-index.json.
 * Also flags the story as `domotics` if any home-automation tool was called.
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

        const response = await makeOpenAI().chat.completions.create({
            model: env.LLM_MODEL,
            messages: [
                {
                    role: 'system',
                    content:
                        'Tu es un moteur de résumé. Résume la conversation suivante en exactement 10 à 15 mots en français. ' +
                        'Commence par le sujet principal (lumières, météo, email, musique…). ' +
                        'Réponds uniquement avec le résumé, sans ponctuation finale.',
                },
                { role: 'user', content: transcript },
            ],
            max_tokens: 40,
            temperature: 0,
        });

        const summary = response.choices[0].message.content?.trim() ?? '';
        if (!summary) return;

        const domotics = isDomotics(entries);

        const index = loadIndex();
        const entry: StoryIndexEntry = {
            id: storyId,
            date: new Date(parseInt(storyId)).toISOString().split('T')[0],
            summary,
            domotics,
        };

        const existing = index.findIndex((e) => e.id === storyId);
        if (existing >= 0) {
            index[existing] = entry;
        } else {
            index.push(entry);
        }

        if (index.length > MAX_INDEX_SIZE) {
            index.splice(0, index.length - MAX_INDEX_SIZE);
        }

        saveIndex(index);
        Logger.debug(
            `Story ${storyId} indexed: "${summary}" (domotics=${domotics})`,
        );
    } catch (err) {
        Logger.warn(`Failed to summarize story ${storyId}: ${err}`);
    }
}

// ── Story retrieval ───────────────────────────────────────────────────────────

export function getStoryTranscript(storyId: string): string {
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
 * LLM-powered story search over a slice of the non-domotics index.
 * Returns matching transcripts, or null if the LLM found no match.
 */
async function searchPage(
    query: string,
    page: StoryIndexEntry[],
    pageLabel: string,
): Promise<string | null> {
    if (page.length === 0) return null;

    const summariesText = page
        .map((e, i) => `[${i + 1}] ${e.date} — ${e.summary} (id: ${e.id})`)
        .join('\n');

    const response = await makeOpenAI().chat.completions.create({
        model: env.LLM_MODEL,
        messages: [
            {
                role: 'system',
                content:
                    'Tu es un moteur de recherche de discussions passées. ' +
                    'À partir de la liste de résumés, trouve les 1 à 3 discussions les plus pertinentes pour la requête. ' +
                    'Réponds UNIQUEMENT avec les IDs séparés par des virgules (ex: 1772062473984,1772062548951). ' +
                    'Si aucune discussion ne correspond, réponds exactement "NONE".',
            },
            {
                role: 'user',
                content: `Requête : "${query}"\n\nRésumés :\n${summariesText}`,
            },
        ],
        max_tokens: 60,
        temperature: 0,
    });

    const result = response.choices[0].message.content?.trim() ?? '';
    Logger.debug(
        `search_stories("${query}") [${pageLabel}] → LLM picked: ${result}`,
    );

    if (!result || result === 'NONE') return null;

    const ids = result
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const found = ids
        .map((id) => page.find((e) => e.id === id))
        .filter((e): e is StoryIndexEntry => e !== undefined);

    if (found.length === 0) return null;

    const parts = found.map((entry) => {
        const transcript = getStoryTranscript(entry.id);
        return `=== [${entry.date}] ${entry.summary} (id: ${entry.id}) ===\n${transcript}`;
    });

    return parts.join('\n\n');
}

/**
 * LLM-powered story search. Takes a natural language query, searches the
 * 10 most recent non-domotics stories first. If nothing matches, searches
 * the next 10 (pagination). Returns summaries + full transcripts of matches.
 *
 * Exposed as the `search_stories(query)` virtual tool.
 */
export async function searchStoriesWithLLM(query: string): Promise<string> {
    const index = loadIndex();
    if (index.length === 0) return 'Aucune discussion passée trouvée.';

    // Non-domotics stories, most recent first
    const nonDomotics = index.filter((e) => !e.domotics).reverse();

    // Page 1: indices 0..9
    const page1 = nonDomotics.slice(0, 10);
    const result1 = await searchPage(query, page1, 'page 1/2');
    if (result1 !== null) return result1;

    // Page 2: indices 10..19 (only if page 1 found nothing)
    const page2 = nonDomotics.slice(10, 20);
    const result2 = await searchPage(query, page2, 'page 2/2');
    if (result2 !== null) return result2;

    return 'Aucune discussion correspondante trouvée.';
}

// ── Startup scan ─────────────────────────────────────────────────────────────

/**
 * Called at orchestrator startup. Finds story files that have no index entry
 * (e.g. from sessions cut short by a crash or PM2 restart) and indexes them.
 * Runs async in the background — does not block startup.
 */
export async function indexMissingStories(): Promise<void> {
    try {
        if (!fs.existsSync(STORIES_DIR)) return;

        const index = loadIndex();
        const indexedIds = new Set(index.map((e) => e.id));

        const files = fs
            .readdirSync(STORIES_DIR)
            .filter((f) => f.startsWith('story-') && f.endsWith('.json'));

        const missing = files
            .map((f) => f.replace('story-', '').replace('.json', ''))
            .filter((id) => !indexedIds.has(id));

        if (missing.length === 0) return;

        Logger.info(`Indexing ${missing.length} unindexed story file(s)…`);

        for (const id of missing) {
            try {
                const filePath = path.join(STORIES_DIR, `story-${id}.json`);
                const entries: StoryEntry[] = JSON.parse(
                    fs.readFileSync(filePath, 'utf-8'),
                );
                await summarizeAndIndex(id, entries);
            } catch (err) {
                Logger.warn(`Could not index story ${id}: ${err}`);
            }
        }
    } catch (err) {
        Logger.warn(`indexMissingStories failed: ${err}`);
    }
}

// ── System prompt injection ───────────────────────────────────────────────────

/**
 * Returns the 3 most recent non-domotics story summaries for injection into
 * every system prompt. Domotics stories (lights, music, doors, TV) are excluded
 * as they are rarely relevant to recall.
 * The LLM can retrieve more via search_stories(query), which paginates 10 by 10.
 */
export function buildStorySummariesContext(): string {
    const index = loadIndex();
    if (index.length === 0) return '';

    // Non-domotics, 3 most recent, newest first.
    // The LLM can retrieve more via search_stories(query) which paginates 10 by 10.
    const recent = index
        .filter((e) => !e.domotics)
        .slice(-3)
        .reverse();
    if (recent.length === 0) return '';

    return recent
        .map((e) => `- [${e.date}] ${e.summary} (id: ${e.id})`)
        .join('\n');
}
