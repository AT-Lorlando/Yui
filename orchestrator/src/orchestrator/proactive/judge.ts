// Le juge d'attention — réservé aux URGENTS. Le non-urgent ne passe plus
// devant lui : il est retenu tel quel et sort dans le prochain point (le
// composeur, `brief/composer.ts`).
//
// Un urgent est arbitré par le LLM avec : la situation courante, ses deltas
// récents, les dernières interventions (anti-radotage), les 👍/👎 de Jérémy (la
// boucle de feedback), et un BUDGET d'interruptions quotidien. Le juge choisit
// ses combats : mieux vaut une intervention qui compte que cinq qui lassent.
import Logger from '../../logger';
import type { Importance } from './types';
import type { Situation } from './situation';
import { summarizeSituation } from './situation';
import type { ProactiveJournal } from './journal';

export interface JudgeInput {
    /** Brique/watcher d'origine (weather, deliveries…). */
    source: string;
    subject: string;
    facts: string;
    importance: Importance;
    kind: 'event';
}

/** Un urgent est dit maintenant, notifié, ou tu : il n'est jamais « retenu »
 *  par le juge — la retenue est le sort du non-urgent, en amont. */
export type JudgeChannel = 'speak' | 'notify' | 'skip';

export interface JudgeVerdict {
    channel: JudgeChannel;
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
- "speak" : Yui parle à voix haute + notification. Réservé à ce qui mérite d'interrompre MAINTENANT.
- "notify" : notification téléphone silencieuse. Pour ce qui doit être su vite sans interrompre.
- "skip" : rien. Déjà connu, banal, ou sans action possible.

Règles :
- Respecte le budget restant : à 0, seul le vraiment urgent passe en speak/notify.
- Ne répète JAMAIS ce qui a déjà été dit (voir interventions récentes).
- Tiens compte des retours 👍/👎 : un type d'intervention régulièrement 👎 doit devenir skip.
- Si Jérémy est absent, "speak" ne sert à rien → "notify".

Le message : une à trois phrases ORALES en français, naturelles, sans markdown, sans emoji. Yui tutoie Jérémy.

Réponds UNIQUEMENT avec un objet JSON : {"channel":"speak|notify|skip","message":"...","reason":"..."} — reason en une phrase courte (visible dans l'app).`;

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
        `ÉVÉNEMENT À JUGER [${input.source}] (importance annoncée : ${input.importance}) : ${input.facts}`,
    );
    return parts.join('\n\n');
}

/** Extrait le verdict JSON de la réponse LLM (tolérant au bruit autour). Pur, testé. */
export function parseVerdict(raw: string): JudgeVerdict | null {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return null;
    try {
        const o = JSON.parse(m[0]);
        // Compat : les anciens canaux « hold » (retenue par le juge) et
        // « digest » (digest quotidien) n'existent plus — un modèle qui les
        // répond encore demande le silence.
        const answered = String(o.channel ?? '');
        const channel =
            answered === 'hold' || answered === 'digest' ? 'skip' : answered;
        if (!['speak', 'notify', 'skip'].includes(channel)) {
            return null;
        }
        return {
            channel: channel as JudgeChannel,
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

        // Garde sans LLM : budget épuisé + rien d'urgent → silence direct.
        if (
            remaining <= 0 &&
            input.importance !== 'urgent' &&
            input.importance !== 'critique'
        ) {
            return {
                channel: 'skip',
                message: input.facts,
                reason: `budget d'interruptions épuisé (${budget}/jour)`,
            };
        }

        try {
            const user = buildJudgeUser(
                input,
                situation,
                deltas,
                remaining,
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

        // Repli sans LLM : l'importance annoncée décide — un urgent est dit,
        // le reste se tait (il n'a rien à faire ici, le point le reprendra).
        if (input.importance === 'urgent' || input.importance === 'critique') {
            return {
                channel: 'speak',
                message: input.facts,
                reason: 'repli sans LLM (importance urgente)',
            };
        }
        return {
            channel: 'skip',
            message: input.facts,
            reason: `repli sans LLM (${input.importance})`,
        };
    }
}
