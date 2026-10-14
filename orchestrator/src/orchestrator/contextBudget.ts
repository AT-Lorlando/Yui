import type OpenAI from 'openai';

/**
 * Garde-fou de contexte LLM (14/10/2026).
 *
 * Deux débordements vécus en prod : `list_tasks` Yoji renvoyait 330 tâches
 * avec descriptions (≈ 440 Ko → 213 k tokens pour 65 k de fenêtre). Rien ne
 * plafonnait un résultat d'outil, et rien ne mesurait la requête avant de
 * l'envoyer. Deux étages, tous deux purs :
 *
 * 1. `capToolResult` : un résultat d'outil ne dépasse jamais
 *    `TOOL_RESULT_MAX_CHARS` — un tableau JSON garde ses premiers éléments
 *    (re-sérialisés compacts), le reste est coupé avec une note explicite
 *    pour que le modèle sache qu'il doit affiner sa requête.
 * 2. `fitMessagesToBudget` : avant chaque tour, la requête (prompt système +
 *    schémas d'outils + messages) est estimée en caractères ; au-delà du
 *    budget, les résultats d'outils du tour courant sont écourtés du plus
 *    gros au plus petit, puis l'historique est abandonné par le plus ancien.
 *
 * Estimation volontairement prudente : 3 caractères par token (JSON et
 * français sous le tokenizer Qwen tournent entre 2,8 et 3,5).
 */

export const TOOL_RESULT_MAX_CHARS =
    Number(process.env.TOOL_RESULT_MAX_CHARS) || 12_000;
export const LLM_CONTEXT_TOKENS =
    Number(process.env.LLM_CONTEXT_TOKENS) || 65_536;
const CHARS_PER_TOKEN = 3;
/** Marge pour la génération (raisonnement + réponse + tool calls). */
const OUTPUT_RESERVE_TOKENS = 6_144;
/** En dessous, un résultat n'est plus écourté (il n'y a plus rien à gagner). */
const STUB_KEEP_CHARS = 300;

export function contextBudgetChars(contextTokens = LLM_CONTEXT_TOKENS): number {
    return Math.max(0, contextTokens - OUTPUT_RESERVE_TOKENS) * CHARS_PER_TOKEN;
}

export function estimateTokens(chars: number): number {
    return Math.ceil(chars / CHARS_PER_TOKEN);
}

function truncateText(content: string, maxChars: number): string {
    const keep = Math.max(0, maxChars - 120);
    return (
        content.slice(0, keep) +
        `\n[… résultat tronqué : ${content.length} caractères au total, ${keep} affichés — affine ta requête]`
    );
}

/** Plafonne un résultat d'outil ; un tableau JSON garde ses premiers éléments. */
export function capToolResult(
    content: string,
    maxChars = TOOL_RESULT_MAX_CHARS,
): string {
    if (content.length <= maxChars) return content;
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return truncateText(content, maxChars);
    }
    if (!Array.isArray(parsed)) return truncateText(content, maxChars);

    const kept: unknown[] = [];
    let size = 2;
    const limit = maxChars - 160;
    for (const item of parsed) {
        const s = JSON.stringify(item);
        if (size + s.length + 1 > limit) break;
        kept.push(item);
        size += s.length + 1;
    }
    if (kept.length === 0) return truncateText(content, maxChars);
    return (
        JSON.stringify(kept) +
        `\n[${kept.length} éléments affichés sur ${parsed.length} — résultat tronqué, affine ta requête (filtre, limite)]`
    );
}

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

export function messageChars(m: Msg): number {
    let n = 0;
    const content = (m as { content?: unknown }).content;
    if (typeof content === 'string') n += content.length;
    else if (content) n += JSON.stringify(content).length;
    const toolCalls = (m as { tool_calls?: unknown }).tool_calls;
    if (toolCalls) n += JSON.stringify(toolCalls).length;
    return n + 20;
}

export interface FitOptions {
    /** Caractères hors messages : prompt système + schémas d'outils. */
    baseChars: number;
    /** Index du message « user » de l'ordre courant — tout ce qui précède (sauf le système) est de l'historique sacrifiable. */
    protectedFrom: number;
    budgetChars?: number;
}

export interface FitReport {
    before: number;
    after: number;
    actions: string[];
}

/**
 * Fait tenir `messages` (modifié en place) dans le budget. Ordre des
 * sacrifices : résultats d'outils du tour courant (du plus gros au plus
 * petit), puis historique (du plus ancien). Le prompt système et l'ordre
 * courant ne sont jamais touchés.
 */
export function fitMessagesToBudget(
    messages: Msg[],
    opts: FitOptions,
): FitReport {
    const budget = opts.budgetChars ?? contextBudgetChars();
    const total = () =>
        opts.baseChars + messages.reduce((n, m) => n + messageChars(m), 0);
    const before = total();
    const actions: string[] = [];
    let protectedFrom = opts.protectedFrom;
    const stubbed = new Set<Msg>();

    // 1. Résultats d'outils du tour courant, du plus gros au plus petit.
    while (total() > budget) {
        let best = -1;
        let bestLen = STUB_KEEP_CHARS;
        for (let i = protectedFrom; i < messages.length; i++) {
            const m = messages[i];
            if (m.role !== 'tool' || typeof m.content !== 'string') continue;
            if (stubbed.has(m)) continue;
            if (m.content.length > bestLen) {
                best = i;
                bestLen = m.content.length;
            }
        }
        if (best < 0) break;
        const m = messages[best] as { content: string };
        stubbed.add(messages[best]);
        m.content =
            m.content.slice(0, STUB_KEEP_CHARS) +
            `\n[… résultat écourté pour tenir dans le contexte (${bestLen} caractères)]`;
        actions.push(`tool result ${bestLen} → ${m.content.length} chars`);
    }

    // 2. Historique, du plus ancien (index 1 = premier message après le système).
    while (total() > budget && protectedFrom > 1) {
        const dropped = messages.splice(1, 1)[0];
        protectedFrom--;
        actions.push(`dropped history ${dropped.role}`);
    }

    return { before, after: total(), actions };
}
