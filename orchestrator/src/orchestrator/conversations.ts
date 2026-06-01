import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import Logger from '../logger';
import { Story, StoryEntry } from './story';
import { upsertIndexEntry } from './storyArchive';

const STORIES_DIR = path.resolve(process.cwd(), 'stories');
const VOICE_IDLE_MS = Number(process.env.CONVERSATION_WINDOW_S ?? 20) * 1000;
const APP_IDLE_MS = 5 * 60_000;

export interface ConversationState {
    id: string;
    story: Story;
    history: OpenAI.Chat.ChatCompletionMessageParam[];
    source: 'voice' | 'app';
    lastActivity: number;
    finalizeTimer?: NodeJS.Timeout;
}

export interface ConversationManagerOptions {
    saveStories: boolean;
    /** Injecté par l'orchestrateur : finalise (résumé + index) une story terminée. */
    onFinalize?: (state: ConversationState) => void;
}

export class ConversationManager {
    private map = new Map<string, ConversationState>();
    private voiceConversationId: string | null = null;

    constructor(private opts: ConversationManagerOptions) {}

    get(id: string): ConversationState | undefined {
        return this.map.get(id);
    }

    private create(
        source: 'voice' | 'app',
        id?: string,
        parentId?: string,
    ): ConversationState {
        const story = new Story({ source, id, parentId });
        const state: ConversationState = {
            id: story.id,
            story,
            history: [],
            source,
            lastActivity: Date.now(),
        };
        this.map.set(state.id, state);
        upsertIndexEntry({
            id: state.id,
            date: new Date(parseInt(state.id)).toISOString().split('T')[0],
            summary: '',
            domotics: false,
            source,
            finished: false,
            ...(parentId ? { parentId } : {}),
        });
        Logger.info(`Conversation created: ${state.id} (${source})`);
        return state;
    }

    getOrCreateVoice(reset: boolean): ConversationState {
        if (reset && this.voiceConversationId) {
            this.finalize(this.voiceConversationId);
            this.voiceConversationId = null;
        }
        if (
            !this.voiceConversationId ||
            !this.map.has(this.voiceConversationId)
        ) {
            const state = this.create('voice');
            this.voiceConversationId = state.id;
            return state;
        }
        return this.map.get(this.voiceConversationId)!;
    }

    getOrCreateApp(conversationId?: string): ConversationState {
        if (conversationId) {
            const existing = this.map.get(conversationId);
            if (existing) return existing;
            return this.resume(conversationId);
        }
        return this.create('app');
    }

    /** Crée une branche de simulation à partir d'une story parente. */
    createBranch(parentId: string): ConversationState {
        return this.create('app', undefined, parentId);
    }

    /** Recharge une story close depuis le disque dans un contexte LLM (texte only). */
    resume(conversationId: string): ConversationState {
        const file = path.join(STORIES_DIR, `story-${conversationId}.json`);
        let entries: StoryEntry[] = [];
        try {
            if (fs.existsSync(file)) {
                entries = JSON.parse(fs.readFileSync(file, 'utf-8'));
            }
        } catch (e) {
            Logger.warn(`resume: lecture ${conversationId} échouée — ${e}`);
        }
        const story = new Story({ source: 'app', id: conversationId });
        for (const e of entries) story.entries.push(e);

        const history: OpenAI.Chat.ChatCompletionMessageParam[] = entries
            .filter((e) => e.role === 'user' || e.role === 'assistant')
            .map((e) => ({
                role: e.role as 'user' | 'assistant',
                content: e.content,
            }));

        const state: ConversationState = {
            id: conversationId,
            story,
            history,
            source: 'app',
            lastActivity: Date.now(),
        };
        this.map.set(conversationId, state);
        upsertIndexEntry({
            id: conversationId,
            date: new Date(parseInt(conversationId))
                .toISOString()
                .split('T')[0],
            summary: '',
            domotics: false,
            source: 'app',
            finished: false,
        });
        Logger.info(`Conversation resumed: ${conversationId}`);
        return state;
    }

    /** (Ré)arme le timer d'idle-finalize selon la source. */
    touch(id: string): void {
        const state = this.map.get(id);
        if (!state) return;
        state.lastActivity = Date.now();
        if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
        const delay = state.source === 'voice' ? VOICE_IDLE_MS : APP_IDLE_MS;
        state.finalizeTimer = setTimeout(() => this.finalize(id), delay);
        state.finalizeTimer.unref?.();
    }

    finalize(id: string): void {
        const state = this.map.get(id);
        if (!state) return;
        if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
        this.map.delete(id);
        if (id === this.voiceConversationId) this.voiceConversationId = null;
        if (!this.opts.saveStories) return;
        this.opts.onFinalize?.(state);
    }

    /** Finalise toutes les conversations ouvertes (shutdown). */
    finalizeAll(): void {
        for (const id of [...this.map.keys()]) this.finalize(id);
    }
}
