// Post-its Yoji nés d'une intention `todo` d'événement. Le registre est la
// garde : une origine (`source:key`) ne produit JAMAIS deux post-its — même
// une fois le post-it terminé (Jérémy l'a fait, on ne le lui remet pas) — et
// un quota quotidien borne ce que Yui écrit dans Yoji sans qu'on lui demande.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import { eventKey } from './events';
import type { Event } from './events';

export interface PostitEntry {
    /** `source:key` de l'événement porteur. */
    origin: string;
    postitId: string;
    /** Création (epoch ms) — le quota compte par jour local. */
    at: number;
    /** Le post-it a disparu de Yoji (fait ou supprimé) : sujet refermé. */
    closed?: boolean;
}

export class PostitRegistry {
    private entries: PostitEntry[] = [];

    constructor(private file?: string) {
        this.load();
    }

    static defaultFile(): string {
        return dataPath('postits.json');
    }

    private load(): void {
        if (!this.file) return;
        try {
            if (!fs.existsSync(this.file)) return;
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
            if (Array.isArray(raw)) {
                this.entries = raw.filter(
                    (e): e is PostitEntry =>
                        typeof e?.origin === 'string' &&
                        typeof e?.postitId === 'string' &&
                        typeof e?.at === 'number',
                );
            }
        } catch {
            /* corrompu → vide */
        }
    }

    private save(): void {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.entries));
        } catch {
            /* best-effort */
        }
    }

    /** Vrai aussi pour une origine close : on ne recrée jamais. */
    has(origin: string): boolean {
        return this.entries.some((e) => e.origin === origin);
    }

    countToday(now: number): number {
        const today = new Date(now).toDateString();
        return this.entries.filter(
            (e) => new Date(e.at).toDateString() === today,
        ).length;
    }

    record(origin: string, postitId: string, now: number): void {
        this.entries.push({ origin, postitId, at: now });
        this.save();
    }

    open(): Array<{ origin: string; postitId: string }> {
        return this.entries
            .filter((e) => !e.closed)
            .map(({ origin, postitId }) => ({ origin, postitId }));
    }

    markClosed(origin: string): void {
        let changed = false;
        for (const e of this.entries) {
            if (e.origin === origin && !e.closed) {
                e.closed = true;
                changed = true;
            }
        }
        if (changed) this.save();
    }
}

export interface CreatePostitDeps {
    registry: PostitRegistry;
    callTool: (
        name: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>;
    /** Quota de créations par jour local. */
    perDay: number;
    now: () => number;
    log: { info(m: string): void; warn(m: string): void };
}

/** Id du post-it créé — le moteur rend le JSON parsé, mais un texte JSON
 *  brut (outil appelé sans ce confort) est accepté aussi. */
function postitIdOf(raw: unknown): string | null {
    let v = raw;
    if (typeof v === 'string') {
        try {
            v = JSON.parse(v);
        } catch {
            return null;
        }
    }
    const id = (v as { id?: unknown } | null)?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/**
 * Crée le post-it d'un événement porteur d'une intention `todo` et pousse
 * dans `e.facts` la ligne qui le dit — l'événement (retenu ou jugé) porte
 * ainsi lui-même le fait. Ne lève jamais : un Yoji injoignable ne doit pas
 * casser l'ingestion.
 */
export async function createPostitFor(
    e: Event,
    deps: CreatePostitDeps,
): Promise<{ created: boolean; reason?: string }> {
    if (!e.todo) return { created: false, reason: 'pas d’intention todo' };
    const origin = eventKey(e);
    if (deps.registry.has(origin)) {
        return {
            created: false,
            reason: `déjà un post-it pour l’origine ${origin}`,
        };
    }
    const now = deps.now();
    const today = deps.registry.countToday(now);
    if (today >= deps.perDay) {
        const reason = `quota de post-its atteint (${today}/${deps.perDay} aujourd’hui)`;
        deps.log.info(`proactive: post-it refusé pour ${origin} — ${reason}`);
        return { created: false, reason };
    }
    const { title, description } = e.todo;
    try {
        const raw = await deps.callTool('create_postit', {
            title,
            ...(description ? { description } : {}),
            tags: [...new Set(['yui', e.source])],
        });
        const id = postitIdOf(raw);
        if (!id) throw new Error('réponse de create_postit sans id');
        deps.registry.record(origin, id, now);
        e.facts.push(`Je t'ai mis un post-it : « ${title} »`);
        deps.log.info(
            `proactive: post-it « ${title} » créé (${id}) pour ${origin}`,
        );
        return { created: true };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.log.warn(`proactive: post-it non créé pour ${origin} — ${reason}`);
        return { created: false, reason };
    }
}
