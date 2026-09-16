// Le juge d'attention — remplace le simple seuil de bavardage.
//
// Chaque intervention candidate (événement de watcher ou moment de vie) est
// arbitrée par le LLM avec : la situation courante, ses deltas récents, les
// dernières interventions (anti-radotage), les 👍/👎 de Jérémy (la boucle de
// feedback), et un BUDGET d'interruptions quotidien. Le juge choisit ses
// combats : mieux vaut une intervention qui compte que cinq qui lassent.
import Logger from '../../logger';
import type { Importance } from './types';
import type { Situation } from './situation';
import { summarizeSituation } from './situation';
import type { ProactiveJournal, JournalChannel } from './journal';

export interface JudgeInput {
    /** Brique/watcher d'origine (weather, deliveries, moment-wake…). */
    source: string;
    subject: string;
    facts: string;
    importance: Importance;
    kind: 'event' | 'moment';
    /** Les moments (réveil, retour…) sont ancrés sur l'activité de Jérémy :
     *  ils n'entament pas le budget d'interruptions. */
    budgetExempt?: boolean;
}

export interface JudgeVerdict {
    channel: JournalChannel;
    message: string;
    reason: string;
}

export interface JudgeDeps {
    complete: (system: string, user: string) => Promise<string>;
    journal: ProactiveJournal;
    budgetPerDay: () => number;
    now?: () => number;
}

const SYSTEM_PROMPT = `Tu es le juge d'attention de Yui, l'assistante domotique de Jérémy.
Ton rôle : décider si une information mérite de l'interrompre, et comment. Jérémy déteste le spam d'assistant (météo banale, rappels évidents) mais veut être prévenu de ce qui compte au bon moment.

Canaux possibles :
- "speak" : Yui parle à voix haute + notification. Réservé à ce qui mérite d'interrompre MAINTENANT, et aux points de moment (réveil, retour) quand il y a de la matière.
- "notify" : notification téléphone silencieuse. Pour l'utile non urgent.
- "digest" : à garder pour le prochain point groupé. Pour le contexte sans urgence.
- "skip" : rien. Déjà connu, banal, ou sans action possible.

Règles :
- Respecte le budget restant : à 0, seul l'urgent passe en speak/notify.
- Ne répète JAMAIS ce qui a déjà été dit (voir interventions récentes).
- Tiens compte des retours 👍/👎 : un type d'intervention régulièrement 👎 doit devenir digest ou skip.
- Si Jérémy est absent, "speak" ne sert à rien → "notify".
- Pour un MOMENT (réveil, départ, retour, coucher) : compose un point bref à partir de la situation — uniquement ce qui est utile À CE MOMENT. S'il n'y a vraiment rien, "skip".

Le message : une à trois phrases ORALES en français, naturelles, sans markdown, sans emoji. Yui tutoie Jérémy.

Réponds UNIQUEMENT avec un objet JSON : {"channel":"speak|notify|digest|skip","message":"...","reason":"..."} — reason en une phrase courte (visible dans l'app).`;

/** Construit le prompt utilisateur du juge. Pur, testé. */
export function buildJudgeUser(
    input: JudgeInput,
    situation: Situation | null,
    deltas: string[],
    remainingBudget: number,
    recent: string,
    feedback: string,
): string {
    const parts: string[] = [];
    if (situation) parts.push(`SITUATION :\n${summarizeSituation(situation)}`);
    if (deltas.length) {
        parts.push(
            `CHANGEMENTS RÉCENTS :\n${deltas.map((d) => `- ${d}`).join('\n')}`,
        );
    }
    parts.push(
        `BUDGET restant aujourd'hui : ${remainingBudget} interruption(s).`,
    );
    if (recent)
        parts.push(`INTERVENTIONS RÉCENTES (ne pas répéter) :\n${recent}`);
    if (feedback) parts.push(`RETOURS DE JÉRÉMY :\n${feedback}`);
    parts.push(
        input.kind === 'moment'
            ? `MOMENT DÉTECTÉ [${input.source}] : ${input.facts}`
            : `ÉVÉNEMENT À JUGER [${input.source}] (importance annoncée : ${input.importance}) : ${input.facts}`,
    );
    return parts.join('\n\n');
}

/** Extrait le verdict JSON de la réponse LLM (tolérant au bruit autour). Pur, testé. */
export function parseVerdict(raw: string): JudgeVerdict | null {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return null;
    try {
        const o = JSON.parse(m[0]);
        const channel = String(o.channel ?? '');
        if (!['speak', 'notify', 'digest', 'skip'].includes(channel)) {
            return null;
        }
        return {
            channel: channel as JournalChannel,
            message: String(o.message ?? '').trim(),
            reason: String(o.reason ?? '').trim(),
        };
    } catch {
        return null;
    }
}

export class Judge {
    constructor(private deps: JudgeDeps) {}

    async evaluate(
        input: JudgeInput,
        situation: Situation | null,
        deltas: string[],
    ): Promise<JudgeVerdict> {
        const now = this.deps.now?.() ?? Date.now();
        const budget = this.deps.budgetPerDay();
        const spent = this.deps.journal.spentToday(now);
        const remaining = Math.max(0, budget - spent);

        // Garde sans LLM : budget épuisé + rien d'urgent → digest direct.
        if (
            remaining <= 0 &&
            !input.budgetExempt &&
            input.importance !== 'urgent' &&
            input.importance !== 'critique'
        ) {
            return {
                channel: 'digest',
                message: input.facts,
                reason: `budget d'interruptions épuisé (${budget}/jour)`,
            };
        }

        try {
            const user = buildJudgeUser(
                input,
                situation,
                deltas,
                input.budgetExempt ? budget : remaining,
                this.deps.journal.recentSummary(now),
                this.deps.journal.feedbackSummary(),
            );
            Logger.info(
                `proactive: juge [${input.source}] "${input.subject}" (budget restant ${remaining})`,
            );
            const raw = await this.deps.complete(SYSTEM_PROMPT, user);
            const verdict = parseVerdict(raw);
            if (verdict) {
                Logger.info(
                    `proactive: verdict [${input.source}] → ${verdict.channel} (${verdict.reason})`,
                );
                return verdict;
            }
            Logger.warn(
                `proactive: verdict illisible pour "${
                    input.subject
                }" — repli heuristique (réponse: ${raw.slice(0, 120)})`,
            );
        } catch (err) {
            Logger.warn(
                `proactive: juge en échec pour "${input.subject}" — repli heuristique (${err})`,
            );
        }

        // Repli sans LLM : l'importance annoncée décide, comme l'ancien seuil.
        if (input.importance === 'urgent' || input.importance === 'critique') {
            return {
                channel: 'speak',
                message: input.facts,
                reason: 'repli sans LLM (importance urgente)',
            };
        }
        if (input.importance === 'utile') {
            return {
                channel: 'notify',
                message: input.facts,
                reason: 'repli sans LLM (utile)',
            };
        }
        return {
            channel: 'digest',
            message: input.facts,
            reason: 'repli sans LLM (info)',
        };
    }
}
