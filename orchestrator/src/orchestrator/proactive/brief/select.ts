// Sélection pure des faits d'un point : exclut ce qui a déjà été dit, trie
// par importance puis ancienneté, plafonne — le `said` est injecté (pur, testable
// sans fichier).
import type { BriefFact, BriefInputs } from './facts';
import type { SaidMemory } from '../said';
import type { Importance } from '../types';
import type { Situation } from '../situation';

export const BRIEF_MAX_FACTS = 8;

const IMPORTANCE_RANK: Record<Importance, number> = {
    critique: 3,
    urgent: 2,
    utile: 1,
    info: 0,
};

export function selectFacts(
    candidates: BriefFact[],
    said: Pick<SaidMemory, 'isSaid'>,
    now: number,
    scope?: BriefInputs['scope'],
): BriefFact[] {
    return candidates
        .filter(
            (f) =>
                // Le scope « today » promet l'agenda du jour : un fait
                // agenda-today déjà dit (ex. par le brief du réveil) doit
                // quand même ressortir ici — seule cette nature échappe au
                // filtre « dit », et seulement pour ce scope.
                (scope === 'today' && f.nature === 'agenda-today') ||
                !said.isSaid(f.subject, f.fingerprint, now),
        )
        .sort(
            (a, b) =>
                IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] ||
                a.at - b.at,
        )
        .slice(0, BRIEF_MAX_FACTS);
}

/** Le moment impose-t-il de parler même sans fait retenu ? La matière
 *  (`held`/situation) décide pour réveil/retour — ici seulement les moments
 *  qui portent leur propre urgence. */
export function momentRequiresSpeech(
    momentKind: BriefInputs['momentKind'],
    situation: Situation | null,
): boolean {
    switch (momentKind) {
        case 'moment-bedtime':
            return situation?.doorLocked === false;
        case 'moment-departure':
            return true;
        default:
            return false;
    }
}
