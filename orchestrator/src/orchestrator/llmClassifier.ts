import type OpenAI from 'openai';
import Logger from '../logger';
import { resolveGroups } from './serverGroups';

/**
 * Catégorisation d'un ordre — remplace l'heuristique seule (`isComplexOrder`)
 * par trois étages, du plus rapide au plus sûr :
 *
 * 1. **Chemin court (0 ms)** : un ordre bref qui matche un groupe d'appareils
 *    (mots-clés de serverGroups) et ne contient aucun mot « intelligent » est
 *    de la domotique directe — pas besoin d'un LLM pour le savoir.
 * 2. **LLM éclair** : sinon, une classification JSON par le modèle local,
 *    thinking coupé, ~15 tokens (~0,3 s mesuré), deadline stricte.
 * 3. **Repli heuristique** : LLM en panne/timeout → l'ancienne heuristique.
 *
 * Catégories :
 *  - `domotique`    : action ou lecture d'état directe → local, sans thinking
 *  - `conversation` : question simple, papotage         → local, sans thinking
 *  - `complexe`     : planification, rédaction, multi-étapes, raisonnement
 *                     → smartProfile (ou local avec thinking)
 */

export type OrderCategory = 'domotique' | 'conversation' | 'complexe';

export interface Classification {
    category: OrderCategory;
    /** D'où vient le verdict (log/debug). */
    source: 'fast-path' | 'llm' | 'heuristic';
}

const SMART_KEYWORDS =
    /\b(planifie|organise|compare|analyse|résume|resume|explique|pourquoi|rédige|redige|écris|ecris|propose|réfléchis|reflechis|prépare|recherche|idée|idees|conseil|stratégie|strategie|calcule|traduis)\b/i;

/** Ancienne heuristique — conservée comme repli et pour les tests. */
export function isComplexOrder(order: string): boolean {
    if (order.length > 180) return true;
    if (SMART_KEYWORDS.test(order)) return true;
    const steps = (order.match(/\b(puis|ensuite|après ça|apres ca)\b/gi) ?? [])
        .length;
    return steps >= 2;
}

/** Étage 1 : domotique évidente, sans LLM. Pur (testé). */
export function fastPathCategory(order: string): OrderCategory | null {
    if (order.length > 90) return null;
    if (SMART_KEYWORDS.test(order)) return null;
    // Multi-étapes explicite → laisser le LLM juger.
    if (/\b(puis|ensuite|après ça|apres ca)\b/i.test(order)) return null;
    if (resolveGroups(order).length > 0) return 'domotique';
    return null;
}

const CLASSIFY_SYSTEM =
    "Tu classes l'ordre d'un utilisateur de maison connectée. Réponds " +
    'UNIQUEMENT un objet JSON {"c":"domotique"|"conversation"|"complexe"}. ' +
    'domotique = action ou question directe sur la maison (lumières, musique, ' +
    'TV, volets, serrure, minuteurs, météo, agenda). conversation = question ' +
    'simple ou papotage. complexe = planification, rédaction, comparaison, ' +
    "raisonnement ou tâche à plusieurs étapes. Pas d'autre texte.";

const CLASSIFY_TIMEOUT_MS = Number(process.env.LLM_CLASSIFY_TIMEOUT_MS ?? 900);

/** Étage 2 : classification LLM éclair (thinking off, deadline stricte). */
async function llmCategory(
    order: string,
    client: OpenAI,
    model: string,
): Promise<OrderCategory | null> {
    try {
        const response = await client.chat.completions.create(
            {
                model,
                messages: [
                    { role: 'system', content: CLASSIFY_SYSTEM },
                    { role: 'user', content: order.slice(0, 400) },
                ],
                temperature: 0,
                max_tokens: 20,
                // llama.cpp/Qwen : pas de raisonnement pour classifier.
                chat_template_kwargs: { enable_thinking: false },
            } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
            { timeout: CLASSIFY_TIMEOUT_MS },
        );
        const raw = response.choices[0]?.message?.content ?? '';
        const json = /\{[\s\S]*?\}/.exec(raw)?.[0];
        if (!json) return null;
        const c = (JSON.parse(json) as { c?: string }).c;
        if (c === 'domotique' || c === 'conversation' || c === 'complexe') {
            return c;
        }
        return null;
    } catch (e) {
        Logger.debug(`classify LLM indisponible: ${e}`);
        return null;
    }
}

/**
 * Classifie un ordre. `client`/`model` = le LLM de classification (le local,
 * ou le petit modèle dédié si configuré).
 */
export async function classifyOrder(
    order: string,
    client: OpenAI,
    model: string,
): Promise<Classification> {
    const fast = fastPathCategory(order);
    if (fast) return { category: fast, source: 'fast-path' };

    const llm = await llmCategory(order, client, model);
    if (llm) return { category: llm, source: 'llm' };

    return {
        category: isComplexOrder(order) ? 'complexe' : 'conversation',
        source: 'heuristic',
    };
}
