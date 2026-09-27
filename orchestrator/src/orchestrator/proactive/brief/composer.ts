// Le composeur de point : relie la sélection pure des faits, le LLM et
// l'émission. Un moment sans matière ni obligation reste SILENCIEUX (aucun
// appel LLM) ; ce qui est dit est marqué dit, retiré de la file des retenus
// et journalisé — jamais l'inverse : rien n'est marqué si rien n'est sorti.
import * as crypto from 'crypto';
import Logger from '../../../logger';
import type { PresenceState } from '../../presence';
import type { HeldQueue } from '../held';
import type { ProactiveJournal } from '../journal';
import type { SaidMemory } from '../said';
import type { Situation } from '../situation';
import type { BriefFact, BriefInputs } from './facts';
import { collectFacts } from './facts';
import { selectFacts, momentRequiresSpeech, BRIEF_MAX_FACTS } from './select';
import {
    BRIEF_SYSTEM_PROMPT,
    buildBriefUser,
    checkComposed,
    templateBrief,
} from './compose';

export interface ComposerDeps {
    complete: (system: string, user: string) => Promise<string>;
    said: SaidMemory;
    held: HeldQueue;
    journal: ProactiveJournal;
    presence: () => PresenceState;
    notify: (text: string) => Promise<void>;
    speak: (text: string) => Promise<void>;
    now: () => number;
    llmTimeoutMs?: number;
}

export interface BriefResult {
    text: string;
    channel: 'speak' | 'notify' | 'brief';
    subjects: string[];
    facts: string[];
    /** Le LLM a été sollicité (même si sa réponse a été refusée). */
    usedLlm: boolean;
    /** Le texte vient du gabarit (LLM absent, en échec ou refusé par la garde). */
    fallback: boolean;
}

// Un appel LLM sans borne hériterait du timeout du client (10 min avec les
// retries) — un point de réveil qui arrive à midi ne sert plus à rien.
export const BRIEF_LLM_TIMEOUT_MS = 60_000;
export const ON_DEMAND_CACHE_MS = 2 * 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error(`brief LLM timeout (${ms} ms)`)),
            ms,
        );
        t.unref?.();
        promise.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}

function fingerprintOf(text: string): string {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** Les faits qui justifient de parler malgré une sélection vide — ajoutés
 *  HORS sélection, jamais filtrés par la mémoire « dit », et portés par le
 *  gabarit (sinon le repli dirait « rien à signaler » au moment même où il
 *  faut parler) : la porte ouverte au coucher, et le départ lui-même (le
 *  rendez-vous a pu être dit au réveil, le départ doit quand même être
 *  annoncé). */
function imposedFacts(input: BriefInputs, now: number): BriefFact[] {
    const { momentKind, momentFacts, situation } = input;
    if (momentKind === 'moment-bedtime' && situation?.doorLocked === false) {
        return [
            {
                subject: 'situation:door-unlocked',
                text: 'La porte n’est pas verrouillée',
                importance: 'urgent',
                at: now,
                nature: 'alert',
                fingerprint: 'door-unlocked',
            },
        ];
    }
    if (momentKind === 'moment-departure' && momentFacts.trim()) {
        const fp = fingerprintOf(momentFacts);
        return [
            {
                subject: `situation:departure-${fp}`,
                text: momentFacts.trim(),
                importance: 'urgent',
                at: now,
                nature: 'info',
                fingerprint: fp,
            },
        ];
    }
    return [];
}

function countLine(n: number, singular: string, plural: string): string {
    return `${n} ${n > 1 ? plural : singular}`;
}

/** « Rien de nouveau. » enrichi de ce qui attend encore (déjà dit, mais toujours là). */
function emptyOnDemandText(situation: Situation | null): string {
    const base = templateBrief('on-demand', []);
    if (!situation) return base;
    const parts: string[] = [];
    if (situation.mailActions.length) {
        parts.push(
            countLine(
                situation.mailActions.length,
                'mail à traiter',
                'mails à traiter',
            ),
        );
    }
    if (situation.parcels.length) {
        parts.push(
            countLine(
                situation.parcels.length,
                'colis en cours',
                'colis en cours',
            ),
        );
    }
    return parts.length ? `${base} ${parts.join(', ')}.` : base;
}

interface CacheSlot {
    at: number;
    result: BriefResult;
}

export class BriefComposer {
    private cache = new Map<string, CacheSlot>();

    constructor(private deps: ComposerDeps) {}

    private select(input: BriefInputs, now: number): BriefFact[] {
        return selectFacts(collectFacts(input, now), this.deps.said, now);
    }

    preview(input: BriefInputs): BriefFact[] {
        return this.select(input, this.deps.now());
    }

    /** LLM borné puis garde déterministe ; tout échec ou refus → gabarit. */
    private async compose(
        input: BriefInputs,
        facts: BriefFact[],
        now: number,
    ): Promise<{ text: string; usedLlm: boolean; fallback: boolean }> {
        const user = buildBriefUser({
            momentKind: input.momentKind,
            momentFacts: input.momentFacts,
            now,
            presence: this.deps.presence(),
            facts,
        });
        try {
            const raw = await withTimeout(
                this.deps.complete(BRIEF_SYSTEM_PROMPT, user),
                this.deps.llmTimeoutMs ?? BRIEF_LLM_TIMEOUT_MS,
            );
            // Le texte du détecteur de moment fait partie du contexte donné au
            // LLM : ses jetons sont tolérés au même titre que ceux des faits.
            const checked = checkComposed(raw, facts, [input.momentFacts]);
            if (checked.ok && checked.text) {
                return { text: checked.text, usedLlm: true, fallback: false };
            }
            Logger.warn(
                `proactive: brief refusé (${
                    checked.ok ? 'vide' : checked.reason
                }) → gabarit`,
            );
        } catch (err) {
            Logger.warn(`proactive: brief LLM en échec (${err}) → gabarit`);
        }
        return {
            text: templateBrief(input.momentKind, facts),
            usedLlm: true,
            fallback: true,
        };
    }

    private channelFor(input: BriefInputs): 'speak' | 'notify' {
        const base = this.deps.presence() === 'home' ? 'speak' : 'notify';
        // Au coucher on ne réveille pas l'enceinte, sauf anomalie de sécurité.
        if (input.momentKind === 'moment-bedtime') {
            return input.situation?.doorLocked === false ? base : 'notify';
        }
        return base;
    }

    /** Marquage dit + retrait ciblé + journal — toujours dans cet ordre, après émission. */
    private settle(
        input: BriefInputs,
        facts: BriefFact[],
        result: Omit<BriefResult, 'subjects' | 'facts'>,
        kind: 'moment' | 'brief',
        now: number,
    ): BriefResult {
        const full: BriefResult = {
            ...result,
            subjects: facts.map((f) => f.subject),
            facts: facts.map((f) => f.text),
        };
        if (facts.length) {
            this.deps.said.markSaid(
                facts.map((f) => ({
                    subject: f.subject,
                    fingerprint: f.fingerprint,
                    nature: f.nature,
                })),
                full.channel,
                now,
            );
            this.deps.held.remove(
                facts.map((f) => f.heldKey).filter((k): k is string => !!k),
            );
        }
        this.deps.journal.record({
            at: now,
            kind,
            source: input.momentKind,
            subject: input.momentKind,
            channel: full.channel,
            message: full.text,
            facts: full.facts,
            subjects: full.subjects,
        });
        return full;
    }

    /** Une sortie sur deux qui échoue ne perd pas le point ; les deux en
     *  échec → rien n'est marqué dit (le moment suivant reprendra la matière)
     *  mais le journal garde une trace `skip` qui explique le silence. */
    private async emit(
        input: BriefInputs,
        channel: 'speak' | 'notify',
        text: string,
        facts: BriefFact[],
        now: number,
    ): Promise<void> {
        const outs: Array<Promise<void>> = [this.deps.notify(text)];
        if (channel === 'speak') outs.push(this.deps.speak(text));
        const settled = await Promise.allSettled(outs);
        const failures = settled.filter(
            (s): s is PromiseRejectedResult => s.status === 'rejected',
        );
        for (const f of failures) {
            Logger.warn(`proactive: brief non émis — ${f.reason}`);
        }
        if (failures.length === settled.length) {
            const err = failures[0]!.reason;
            this.deps.journal.record({
                at: now,
                kind: 'moment',
                source: input.momentKind,
                subject: input.momentKind,
                channel: 'skip',
                message: text,
                reason: `émission impossible : ${
                    err instanceof Error ? err.message : String(err)
                }`,
                facts: facts.map((f) => f.text),
                subjects: facts.map((f) => f.subject),
            });
            throw err;
        }
    }

    async forMoment(input: BriefInputs): Promise<BriefResult | null> {
        const now = this.deps.now();
        // Les faits imposés passent devant (ils sont urgents) ; le plafond
        // s'applique au total, en rognant la queue de la sélection.
        const facts = [
            ...imposedFacts(input, now),
            ...this.select(input, now),
        ].slice(0, BRIEF_MAX_FACTS);
        if (
            facts.length === 0 &&
            !momentRequiresSpeech(input.momentKind, input.situation)
        ) {
            return null;
        }
        const composed = await this.compose(input, facts, now);
        const channel = this.channelFor(input);
        await this.emit(input, channel, composed.text, facts, now);
        return this.settle(
            input,
            facts,
            { ...composed, channel },
            'moment',
            now,
        );
    }

    async onDemand(input: BriefInputs): Promise<BriefResult> {
        const now = this.deps.now();
        const scope = input.scope ?? 'since-last';
        const hit = this.cache.get(scope);
        if (hit && now - hit.at < ON_DEMAND_CACHE_MS) return hit.result;

        const facts = this.select(input, now);
        const composed = facts.length
            ? await this.compose(input, facts, now)
            : {
                  text: emptyOnDemandText(input.situation),
                  usedLlm: false,
                  fallback: true,
              };
        const result = this.settle(
            input,
            facts,
            { ...composed, channel: 'brief' },
            'brief',
            now,
        );
        this.cache.set(scope, { at: now, result });
        return result;
    }
}
