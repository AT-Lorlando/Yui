// Étages déterministes du tri (règles puis signaux) et repli — 0 token avant
// le LLM. L'orchestration (concierge) reste hors de ce module : ces fonctions
// sont pures, testables sans réseau ni fichier.
import type { MailRule, RuleMail } from './rules';
import { firstMatch } from './rules';
import type { Signal } from './signals';
import { detectSignal, signalAllowed } from './signals';

export type Stage = 'rule' | 'signal' | 'llm' | 'fallback';
export type Urgency = 'none' | 'soon' | 'now';

export interface Verdict {
    category: string;
    stage: Stage;
    ruleId?: string;
    signal?: Signal;
    urgency?: Urgency;
    reason?: string;
    final: boolean;
}

// Repli LLM par lots (0 token pour le reste, coût borné par sondage).
export const LLM_BATCH = 12;
export const LLM_PER_POLL = 24;
export const FALLBACK_MAX_TRIES = 3;

/**
 * Étage 1 (règles) puis étage 2 (signaux) — jamais les deux à la fois :
 * une règle négative confirmée court-circuite le signal et renvoie au LLM.
 */
export function deterministicVerdict(
    mail: RuleMail,
    rules: MailRule[],
    validCategories: Set<string>,
): Verdict | null {
    const rule = firstMatch(rules, mail);
    if (rule) {
        if (rule.confirmed) {
            const category = rule.then.category;
            if (category === null) {
                // règle négative : bloque toute conclusion automatique, y compris un signal — direction LLM
                return null;
            }
            if (validCategories.has(category)) {
                return {
                    category,
                    stage: 'rule',
                    ruleId: rule.id,
                    final: true,
                };
            }
            // catégorie devenue inconnue (supprimée depuis) : la règle est périmée, on continue comme si elle n'existait pas
        } else {
            // règle en quarantaine (signal appris, pas encore confirmé) : proposition seulement
            return {
                category: rule.then.category as string,
                stage: 'signal',
                ruleId: rule.id,
                final: false,
            };
        }
    }

    if (signalAllowed(rules, mail)) {
        const hit = detectSignal(mail);
        if (hit) {
            return {
                category: hit.category,
                stage: 'signal',
                signal: hit.signal,
                final: false,
            };
        }
    }

    return null;
}

/** Garde l'ordre d'entrée : les `cap` premiers passent au LLM ce tour, le reste attend le prochain sondage. */
export function splitForLlm<T>(
    mails: T[],
    cap: number = LLM_PER_POLL,
): { now: T[]; later: T[] } {
    return { now: mails.slice(0, cap), later: mails.slice(cap) };
}

/** Aucune conclusion possible : rangé en lecture plutôt que bloqué indéfiniment. */
export function fallbackVerdict(): Verdict {
    return { category: 'lire', stage: 'fallback', final: false };
}
