// Post-its Yoji (tâches sans projet) : état courant pour la situation, et
// ceux qui traînent depuis plus d'une semaine, exposés sous un label dédié
// que la collecte des faits du brief transforme en rappel (nature
// `postit-stale`). Pas de poll : rien d'événementiel ici, Yoji n'émet pas.
import type { Fact } from '../events';
import type { ConnectorDef } from '../connector';

/** Au-delà, un post-it « traîne » et mérite un rappel au point. */
export const STALE_DAYS = 7;
/** Forme de la valeur d'un fait post-it : `<titre> (<âge> j)` — la collecte
 *  du brief la décompose (titre, âge) pour formuler un rappel sans ambiguïté. */
export const POSTIT_VALUE_RE = /^(.+) \((\d+) j\)$/;
const MAX_FACTS = 8;
/** Tag posé par Yui sur ce qu'elle crée — ces post-its passent devant. */
const OWN_TAG = 'yui';

interface PostitLike {
    id: string;
    title: string;
    tags: string[];
    ageDays: number;
}

function asPostit(raw: unknown): PostitLike | null {
    const p = raw as Partial<PostitLike> | null;
    if (!p || typeof p !== 'object') return null;
    const id =
        typeof p.id === 'string' || typeof p.id === 'number'
            ? String(p.id)
            : '';
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (!id || !title) return null;
    return {
        id,
        title,
        tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
        ageDays:
            typeof p.ageDays === 'number' && Number.isFinite(p.ageDays)
                ? Math.max(0, Math.floor(p.ageDays))
                : 0,
    };
}

/** Faits de situation d'une liste `list_postits`. Pur. */
export function postitFacts(list: unknown[]): Fact[] {
    const postits = list
        .map(asPostit)
        .filter((p): p is PostitLike => p !== null);
    // Tri stable : les post-its de Yui d'abord, l'ordre de Yoji ensuite.
    const own = postits.filter((p) => p.tags.includes(OWN_TAG));
    const others = postits.filter((p) => !p.tags.includes(OWN_TAG));
    return [...own, ...others].slice(0, MAX_FACTS).map((p) => ({
        label: p.ageDays > STALE_DAYS ? 'Post-it ancien' : 'Post-it',
        value: `${p.title} (${p.ageDays} j)`,
        key: p.id,
    }));
}

/** Le moteur rend le JSON parsé ; un texte JSON brut est accepté aussi. */
function asList(raw: unknown): unknown[] {
    let v = raw;
    if (typeof v === 'string') {
        try {
            v = JSON.parse(v);
        } catch {
            /* traité ci-dessous */
        }
    }
    if (!Array.isArray(v)) throw new Error('list_postits : liste attendue');
    return v;
}

export const yojiConnector: ConnectorDef = {
    id: 'yoji',
    name: 'Post-its Yoji',
    description:
        'Post-its Yoji dans la situation, et rappel de ceux qui traînent depuis plus d’une semaine.',
    defaultEnabled: true,
    async snapshot(ctx): Promise<Fact[]> {
        return postitFacts(asList(await ctx.callTool('list_postits')));
    },
};
