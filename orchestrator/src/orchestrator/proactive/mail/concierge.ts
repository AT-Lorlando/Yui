// Concierge courrier — trie la boîte Gmail en continu.
//
// Chaque mail entrant traverse quatre étages, du moins au plus cher :
//  1. règles (`mail-rules.json`, RuleStore) — confirmées seulement, 0 token,
//     application directe (label + archive selon la catégorie) ;
//  2. signaux de masse (en-têtes de liste, expéditeur automatisé) — label
//     SEUL, jamais d'archive, et une règle « signal » non confirmée est
//     apprise (quarantaine : Jérémy la confirme ou la corrige) ;
//  3. LLM par lots, EN LISANT LE CORPS, borné à LLM_PER_POLL mails par
//     sondage — le reste attend le suivant ;
//  4. repli « lire » après FALLBACK_MAX_TRIES échecs consécutifs du LLM.
// Le résultat est matérialisé en label Gmail « Yui/… » : le tri est visible
// partout, pas enfermé dans l'app. Mode PROPOSITIONS par défaut : rien n'est
// appliqué sans validation, sauf les catégories `concierge.autoCategories`,
// les règles confirmées et les étages déterministes.
//
// Boucles d'apprentissage :
//  - une correction crée (ou promeut) une règle par expéditeur ;
//  - règles de prompt (`concierge.promptRules`) et catégories personnalisées
//    (`concierge.customCategories`) ;
//  - les DOUTES : quand le LLM hésite, il le dit et propose des règles ou une
//    nouvelle catégorie ; l'app notifie, Jérémy tranche, et ce qu'il accepte
//    alimente les précédentes pour la prochaine analyse.
//
// Sécurité : on ne SUPPRIME jamais — au pire on archive (réversible), et
// uniquement pour les catégories d'archivage.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';
import type { ConciergeRule, CustomCategory } from '../types';
import {
    newRule,
    ruleFor,
    ruleFromCorrection,
    ruleFromSignal,
    senderDomain,
    sortRules,
    validateRuleInput,
} from './rules';
import type { MailRule, RuleMail, RuleStore } from './rules';
import {
    deterministicVerdict,
    fallbackVerdict,
    splitForLlm,
    FALLBACK_MAX_TRIES,
    LLM_BATCH,
    LLM_PER_POLL,
} from './triage';
import type { Stage, Urgency } from './triage';
import type { MailDecision, MailJournal } from './journal';

// senderDomain vit désormais dans rules.ts (partagé avec le modèle de règles) ; ré-exporté pour ne pas casser les imports existants (concierge.test.ts).
export { senderDomain };

/** Catégorie = id libre (base ou personnalisée). */
export type MailCategory = string;

export interface CategoryDef {
    id: string;
    label: string;
    description: string;
    /** Valider la proposition archive aussi (sort de la boîte de réception). */
    archive: boolean;
    custom?: boolean;
}

export const BASE_CATEGORIES: CategoryDef[] = [
    {
        id: 'action',
        label: 'Yui/Action',
        description:
            'UNIQUEMENT si le mail attend explicitement quelque chose de lui — une réponse, un paiement, une échéance, une décision, un document à fournir, un incident à corriger. Un mail qui « le concerne » sans rien lui demander n’est PAS une action.',
        archive: false,
    },
    {
        id: 'perso',
        label: 'Yui/Perso',
        description:
            'Message écrit par une vraie personne (ami, famille, contact) — pas un automate ni une entreprise.',
        archive: false,
    },
    {
        id: 'lire',
        label: 'Yui/A lire',
        description:
            'Mérite d’être lu, sans action : suivi d’un dossier ou d’un projet auquel il participe, information ponctuelle qui le touche directement.',
        archive: false,
    },
    {
        id: 'finance',
        label: 'Yui/Finance',
        description:
            'Banque, relevés, rapports de solde, reçus de paiement, factures réglées, impôts.',
        archive: false,
    },
    {
        id: 'securite',
        label: 'Yui/Sécurité',
        description:
            'Avis de sécurité automatiques : nouvelle connexion, clé d’accès, mot de passe, données partagées entre services.',
        archive: false,
    },
    {
        id: 'admin',
        label: 'Yui/Admin',
        description:
            'Autre administratif à garder : confirmations d’inscription, attestations, mises à jour de CGU, messages de bienvenue d’un service, contributions.',
        archive: false,
    },
    {
        id: 'commande',
        label: 'Yui/Commandes',
        description:
            'Achats et livraisons : confirmation de commande, expédition, suivi de colis, facture d’achat en ligne.',
        archive: false,
    },
    {
        id: 'evenement',
        label: 'Yui/Événements',
        description:
            'Invitations, inscriptions à des courses/sorties/soirées, billets, rappels d’événement.',
        archive: false,
    },
    {
        id: 'notification',
        label: 'Yui/Notifications',
        description:
            'Message automatique d’un service (confirmation, alerte système, relevé, rappel de connexion) — aucun humain derrière, rien à faire.',
        archive: true,
    },
    {
        id: 'newsletter',
        label: 'Yui/Newsletters',
        description:
            'Lettres d’information éditoriales ou récapitulatives (contenu, actualités d’un service, remerciements de campagne).',
        archive: true,
    },
    {
        id: 'promo',
        label: 'Yui/Promos',
        description:
            'Marketing d’une marque qu’il connaît : soldes, offres, relances commerciales, jeux en ligne, demandes d’avis produit.',
        archive: true,
    },
    {
        id: 'osef',
        label: 'Yui/Osef',
        description:
            'Sans aucun intérêt pour lui : alertes non sollicitées, séquences de prospection automatisées (« c’est X, j’ai bientôt terminé… »), démarchage, tout ce qu’il ne lira jamais.',
        archive: true,
    },
];

export function allCategories(custom: CustomCategory[] = []): CategoryDef[] {
    const base = BASE_CATEGORIES.map((c) => ({ ...c }));
    const ids = new Set(base.map((c) => c.id));
    for (const c of custom) {
        if (!c?.id || ids.has(c.id)) continue;
        ids.add(c.id);
        base.push({
            id: c.id,
            label: c.label ?? `Yui/${c.id}`,
            description: c.description ?? '',
            archive: c.archive === true,
            custom: true,
        });
    }
    return base;
}

export function categoryDef(
    id: string,
    custom: CustomCategory[] = [],
): CategoryDef | undefined {
    return allCategories(custom).find((c) => c.id === id);
}

export interface TriageProposal {
    mailId: string;
    from: string;
    subject: string;
    category: MailCategory;
    via: 'rule' | 'llm' | 'signal' | 'fallback';
    /** Étage qui a conclu — absent sur les propositions antérieures au pipeline. */
    stage?: Stage;
    /** Règle qui a conclu ou a été apprise (étages règle et signal). */
    ruleId?: string;
    urgency?: Urgency;
    reason?: string;
    proposeArchive: boolean;
    /** Posé quand le label a été réellement appliqué. */
    appliedAt?: number;
    /** Appliqué automatiquement (catégorie en autoCategories / règle). */
    auto?: boolean;
    /** Le LLM a hésité sur ce mail (voir `doubts`). */
    doubt?: boolean;
}

export interface DoubtSuggestion {
    kind: 'rule' | 'category';
    /** Règle : phrase à injecter dans le prompt. Catégorie : description. */
    text: string;
    /** Catégorie proposée (kind=category). */
    id?: string;
    label?: string;
    archive?: boolean;
}

export interface TriageDoubt {
    id: string;
    mailId: string;
    from: string;
    subject: string;
    /** Catégorie retenue faute de mieux. */
    category: MailCategory;
    /** Pourquoi le LLM hésite (visible dans l'app). */
    reason: string;
    /** Catégories entre lesquelles il hésite. */
    alternatives: MailCategory[];
    suggestions: DoubtSuggestion[];
    at: number;
    resolvedAt?: number;
}

export interface TriageState {
    proposals: TriageProposal[];
    doubts: TriageDoubt[];
    /** Ids déjà traités (borné) — évite de reclasser au poll suivant. */
    processedIds: string[];
    /** mailId → échecs LLM consécutifs ; au-delà de FALLBACK_MAX_TRIES le mail est rangé en lecture. */
    fallbackTries: Record<string, number>;
    stats: { classified: number; applied: number; corrected: number };
    lastScanAt?: number;
}

/** Mail tel que le concierge le manipule : forme de list_messages_meta + corps lu à la demande. */
export interface ConciergeMail extends RuleMail {
    threadId: string;
    labelIds: string[];
    body?: string;
}

const STATE_FILE = dataPath('mail-triage.json');
const MAX_PROCESSED = 1000;
const MAX_PROPOSALS = 200;
const MAX_DOUBTS = 60;
const MAX_FALLBACK = 200;
/** Corps de mail injecté dans le prompt (par mail). */
const BODY_CHARS = 700;

export function loadTriage(file: string = STATE_FILE): TriageState {
    try {
        if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return {
                proposals: Array.isArray(raw.proposals) ? raw.proposals : [],
                doubts: Array.isArray(raw.doubts) ? raw.doubts : [],
                processedIds: Array.isArray(raw.processedIds)
                    ? raw.processedIds
                    : [],
                // un fichier écrit avant le pipeline n'a pas ce champ
                fallbackTries:
                    raw.fallbackTries &&
                    typeof raw.fallbackTries === 'object' &&
                    !Array.isArray(raw.fallbackTries)
                        ? raw.fallbackTries
                        : {},
                stats: raw.stats ?? { classified: 0, applied: 0, corrected: 0 },
                lastScanAt: raw.lastScanAt,
            };
        }
    } catch (err) {
        Logger.warn(`concierge: état illisible — ${err}`);
    }
    return {
        proposals: [],
        doubts: [],
        processedIds: [],
        fallbackTries: {},
        stats: { classified: 0, applied: 0, corrected: 0 },
    };
}

export function saveTriage(st: TriageState, file: string = STATE_FILE): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Plafonné comme les autres listes : sans borne, un LLM en panne
        // prolongée gonflerait ce dictionnaire indéfiniment. L'ordre des clés
        // d'un objet suit l'insertion — les plus anciennes sautent en premier.
        const fallbackKeys = Object.keys(st.fallbackTries);
        const fallbackTries =
            fallbackKeys.length > MAX_FALLBACK
                ? Object.fromEntries(
                      fallbackKeys
                          .slice(-MAX_FALLBACK)
                          .map((k) => [k, st.fallbackTries[k]!]),
                  )
                : st.fallbackTries;
        fs.writeFileSync(
            file,
            JSON.stringify({
                ...st,
                proposals: st.proposals.slice(-MAX_PROPOSALS),
                doubts: st.doubts.slice(-MAX_DOUBTS),
                processedIds: st.processedIds.slice(-MAX_PROCESSED),
                fallbackTries,
            }),
        );
    } catch (err) {
        Logger.warn(`concierge: état non persisté — ${err}`);
    }
}

/** Règle apprise applicable ? (sous-chaîne dans l'expéditeur, insensible à la casse) */
export function applyRules(
    rules: ConciergeRule[] | undefined,
    from: string,
    validCategories: Set<string>,
): MailCategory | null {
    if (!rules) return null;
    const lc = from.toLowerCase();
    for (const r of rules) {
        if (
            r.match &&
            lc.includes(r.match.toLowerCase()) &&
            validCategories.has(r.category)
        ) {
            return r.category;
        }
    }
    return null;
}

/** Corps utile d'une sortie get_email (après « --- Corps --- »), compacté. */
export function extractBody(full: string, max = BODY_CHARS): string {
    const idx = full.indexOf('--- Corps ---');
    const body = (idx >= 0 ? full.slice(idx + 13) : full)
        .replace(/https?:\/\/\S+/g, '[lien]')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
    return body.length > max ? body.slice(0, max) + '…' : body;
}

/**
 * Sortie de list_messages_meta → mails du concierge. Le moteur livre déjà le
 * tableau parsé quand le texte est du JSON ; un texte brut est aussi accepté.
 * Tout ce qui n'est pas exploitable vaut [] (un mail sans id est ignoré).
 */
export function parseMetaList(raw: unknown): ConciergeMail[] {
    let list: unknown = raw;
    if (typeof raw === 'string') {
        try {
            list = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(list)) return [];
    const out: ConciergeMail[] = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : '';
        if (!id) continue;
        const headers: Record<string, string> = {};
        if (o.headers && typeof o.headers === 'object') {
            for (const [k, v] of Object.entries(
                o.headers as Record<string, unknown>,
            )) {
                if (typeof v === 'string') headers[k] = v;
            }
        }
        out.push({
            id,
            threadId: typeof o.threadId === 'string' ? o.threadId : '',
            from: typeof o.from === 'string' ? o.from : '',
            subject: typeof o.subject === 'string' ? o.subject : '',
            snippet: typeof o.snippet === 'string' ? o.snippet : '',
            headers,
            labelIds: Array.isArray(o.labelIds)
                ? o.labelIds.filter((l): l is string => typeof l === 'string')
                : [],
        });
    }
    return out;
}

/** System prompt : catégories (base + perso) + règles apprises. Pur, testé. */
export function buildClassifySystem(
    categories: CategoryDef[],
    promptRules: string[] = [],
): string {
    const cats = categories
        .map((c) => `- "${c.id}" : ${c.description}`)
        .join('\n');
    const rules = promptRules.length
        ? `\nRÈGLES DE JÉRÉMY (prioritaires) :\n${promptRules
              .map((r) => `- ${r}`)
              .join('\n')}\n`
        : '';
    return `Tu tries la boîte mail de Jérémy. Pour chaque mail numéroté (expéditeur, objet, début du corps), choisis UNE catégorie :
${cats}
${rules}
En cas d'hésitation entre "action" et autre chose : ce n'est pas une action.

Pour chaque mail, indique aussi "urgency" :
- "none" (défaut) : rien n'est attendu de lui, ou pas de date.
- "soon" : quelque chose est attendu de lui sous quelques jours (échéance, relance, document à fournir).
- "now" : à traiter aujourd'hui — échéance dans les 48 h, accès ou sécurité d'un compte, une personne qui attend sa réponse aujourd'hui, un incident en cours.
"now" est RARE. Une newsletter, une promo, une notification ou un message marketing n'est JAMAIS "soon" ni "now", quel que soit son vocabulaire (« urgent », « dernière chance »). Donne "reason" : une ligne factuelle (la date ou la demande), vide si "none".

Si tu HÉSITES vraiment sur un mail (deux catégories plausibles, ou aucune ne colle), dis-le : "doubt":true, "reason" en une phrase, "alternatives" (les catégories envisagées), et propose dans "suggestions" ce qui te permettrait de trancher la prochaine fois — soit une règle en français à ajouter au prompt ({"kind":"rule","text":"Les alertes immobilières sont osef"}), soit une nouvelle catégorie ({"kind":"category","id":"immo","label":"Yui/Immobilier","text":"Annonces et alertes immobilières","archive":true}). Ne propose rien pour un mail sûr.

Réponds UNIQUEMENT en JSON : [{"i":1,"category":"action","urgency":"soon","reason":"Échéance le 3 octobre"},{"i":2,"category":"lire","doubt":true,"reason":"…","alternatives":["lire","admin"],"suggestions":[…]}] — un objet par mail, dans l'ordre.`;
}

/** Prompt utilisateur du lot (corps compacté si fourni). Pur, testé. */
export function buildClassifyUser(
    mails: Array<
        Pick<RuleMail, 'id' | 'from' | 'subject' | 'snippet'> & {
            body?: string;
        }
    >,
): string {
    return mails
        .map(
            (m, i) =>
                `${i + 1}. De: ${m.from}\n   Objet: ${m.subject}\n   ${
                    m.body
                        ? `Corps: ${m.body}`
                        : `Aperçu: ${m.snippet.slice(0, 150)}`
                }`,
        )
        .join('\n\n');
}

export interface ClassifyItem {
    category: MailCategory;
    urgency: Urgency;
    reason: string;
    doubt?: {
        reason: string;
        alternatives: MailCategory[];
        suggestions: DoubtSuggestion[];
    };
}

/** Parse la réponse du LLM — null par mail illisible. Pur, testé. */
export function parseClassifyReply(
    raw: string,
    count: number,
    valid: Set<string>,
): Array<ClassifyItem | null> {
    const out: Array<ClassifyItem | null> = new Array(count).fill(null);
    const m = /\[[\s\S]*\]/.exec(raw);
    if (!m) return out;
    try {
        const arr = JSON.parse(m[0]);
        if (!Array.isArray(arr)) return out;
        for (const item of arr) {
            const i = Number(item?.i) - 1;
            const cat = String(item?.category ?? '');
            if (i < 0 || i >= count || !valid.has(cat)) continue;
            // urgency/reason toujours présentes (défaut "none"/"") : une valeur
            // absente ou inconnue du LLM ne doit jamais remonter comme urgente.
            const urgency: Urgency =
                item?.urgency === 'soon' || item?.urgency === 'now'
                    ? item.urgency
                    : 'none';
            const reason =
                typeof item?.reason === 'string'
                    ? item.reason.trim().slice(0, 160)
                    : '';
            const entry: ClassifyItem = { category: cat, urgency, reason };
            if (item?.doubt === true) {
                const suggestions: DoubtSuggestion[] = [];
                for (const s of Array.isArray(item.suggestions)
                    ? item.suggestions
                    : []) {
                    const kind = s?.kind === 'category' ? 'category' : 'rule';
                    const text = String(s?.text ?? '').trim();
                    if (!text) continue;
                    if (kind === 'category') {
                        const id = String(s?.id ?? '')
                            .toLowerCase()
                            .replace(/[^a-z0-9_-]/g, '');
                        if (!id || valid.has(id)) continue;
                        suggestions.push({
                            kind,
                            text,
                            id,
                            label: String(s?.label ?? `Yui/${id}`),
                            archive: s?.archive === true,
                        });
                    } else {
                        suggestions.push({ kind, text });
                    }
                }
                entry.doubt = {
                    reason: String(item.reason ?? '').trim(),
                    alternatives: (Array.isArray(item.alternatives)
                        ? item.alternatives
                        : []
                    )
                        .map(String)
                        .filter((a: string) => valid.has(a)),
                    suggestions: suggestions.slice(0, 4),
                };
            }
            out[i] = entry;
        }
    } catch {
        /* réponse illisible → tous null */
    }
    return out;
}

export interface ConciergeDeps {
    deviceHandler: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>;
    complete: (system: string, user: string) => Promise<string>;
    rules: RuleStore;
    journal: MailJournal;
    getAutoCategories: () => MailCategory[];
    getPromptRules?: () => string[];
    addPromptRule?: (text: string) => void;
    getCustomCategories?: () => CustomCategory[];
    addCustomCategory?: (c: CustomCategory) => void;
    /** Nouveaux doutes après un scan → l'app notifie (best-effort). */
    onDoubts?: (doubts: TriageDoubt[]) => void;
    /** Une correction change la catégorie retenue — le moteur s'en sert pour
     *  refermer le sujet proactif d'un mail qui n'est plus « action ». */
    onCorrected?: (mailId: string, previous: string, next: string) => void;
    /** Lire le corps des mails avant classement (défaut oui). */
    readBodies?: boolean;
    now?: () => number;
}

export class MailConcierge {
    private state: TriageState;
    private stateFile: string;

    constructor(private deps: ConciergeDeps, stateFile?: string) {
        this.stateFile = stateFile ?? STATE_FILE;
        this.state = loadTriage(this.stateFile);
    }

    getState(): TriageState {
        return this.state;
    }

    categories(): CategoryDef[] {
        return allCategories(this.deps.getCustomCategories?.() ?? []);
    }

    private validIds(): Set<string> {
        return new Set(this.categories().map((c) => c.id));
    }

    private labelOf(category: MailCategory): string {
        return (
            categoryDef(category, this.deps.getCustomCategories?.() ?? [])
                ?.label ?? `Yui/${category}`
        );
    }

    private archives(category: MailCategory): boolean {
        return (
            categoryDef(category, this.deps.getCustomCategories?.() ?? [])
                ?.archive ?? false
        );
    }

    /** Propositions en attente (non appliquées). */
    pending(): TriageProposal[] {
        return this.state.proposals.filter((p) => !p.appliedAt);
    }

    /** Doutes non tranchés. */
    openDoubts(): TriageDoubt[] {
        return this.state.doubts.filter((d) => !d.resolvedAt);
    }

    /** Propositions « lire » appliquées ces 7 derniers jours — approximation
     *  locale de la pile à lire (le compte exact vient de Gmail, Task 7). */
    readingCount(): number {
        const now = this.deps.now?.() ?? Date.now();
        const WEEK_MS = 7 * 24 * 3600_000;
        return this.state.proposals.filter(
            (p) =>
                p.category === 'lire' &&
                p.appliedAt !== undefined &&
                now - p.appliedAt < WEEK_MS,
        ).length;
    }

    /** Toutes les règles, triées dans l'ordre d'évaluation (user → correction → signal). */
    rules(): MailRule[] {
        return sortRules(this.deps.rules.all());
    }

    /** Règles apprises d'un signal et pas encore confirmées — à valider ou corriger depuis l'app. */
    quarantine(): Array<{
        ruleId: string;
        from: string;
        category: string;
        hits: number;
        lastHitAt?: number;
        lastSubject?: string;
    }> {
        return this.rules()
            .filter((r) => r.origin === 'signal' && !r.confirmed)
            .map((r) => {
                // le dernier sujet vient des propositions : la règle ne le mémorise pas
                let lastSubject: string | undefined;
                for (let i = this.state.proposals.length - 1; i >= 0; i--) {
                    if (this.state.proposals[i]!.ruleId === r.id) {
                        lastSubject = this.state.proposals[i]!.subject;
                        break;
                    }
                }
                return {
                    ruleId: r.id,
                    from: r.when.from ?? '',
                    category: r.then.category ?? '',
                    hits: r.hits,
                    ...(r.lastHitAt !== undefined
                        ? { lastHitAt: r.lastHitAt }
                        : {}),
                    ...(lastSubject !== undefined ? { lastSubject } : {}),
                };
            });
    }

    /** Décisions déjà journalisées (page /mail) — même anneau que `deps.journal`. */
    listJournal(limit?: number): MailDecision[] {
        return this.deps.journal.list(limit);
    }

    /**
     * Règle manuelle (page /mail) : `input.id` désigne une règle existante à
     * remplacer (id/hits/createdAt conservés) — sinon une règle neuve est
     * créée. Toujours `origin:'user'`, `confirmed:true` : posée à la main,
     * elle n'a pas besoin de repasser par la quarantaine.
     */
    saveRule(
        input: unknown,
    ): { ok: true; rule: MailRule } | { ok: false; error: string } {
        const validated = validateRuleInput(input, this.validIds());
        if (!validated.ok) return validated;
        const now = this.deps.now?.() ?? Date.now();
        const id = (input as Record<string, unknown>).id;
        const existing =
            typeof id === 'string'
                ? this.deps.rules.all().find((r) => r.id === id)
                : undefined;
        const fresh = newRule({
            when: validated.rule.when,
            category: validated.rule.then.category,
            origin: 'user',
            confirmed: true,
            now,
        });
        const rule: MailRule = existing
            ? {
                  ...fresh,
                  id: existing.id,
                  hits: existing.hits,
                  createdAt: existing.createdAt,
              }
            : fresh;
        this.deps.rules.upsert(rule);
        return { ok: true, rule };
    }

    /** Supprime une règle (utilisateur, correction ou quarantaine rejetée). */
    deleteRule(id: string): boolean {
        return this.deps.rules.remove(id);
    }

    /**
     * Décision humaine sur une règle de quarantaine (signal non confirmé) :
     * `confirm` l'entérine (et archive rétroactivement si la catégorie
     * archive), `correct` la remplace par une règle de correction confirmée,
     * `reject` la supprime et apprend une règle négative (l'expéditeur ne
     * sera plus jamais conclu par un signal, direction LLM). Rattrapage
     * rétroactif des mails déjà étiquetés, plafonné à 100, best-effort par
     * mail — jamais de suppression.
     */
    async quarantineAct(
        ruleId: string,
        action: 'confirm' | 'correct' | 'reject',
        opts: { category?: string } = {},
    ): Promise<boolean> {
        const rule = this.deps.rules.all().find((r) => r.id === ruleId);
        // seule une règle de quarantaine réelle (signal, pas encore
        // confirmée) peut être décidée ici — sinon `reject` supprimerait une
        // règle utilisateur/correction et dérangerait ses mails, et
        // `confirm` réarchiverait une règle déjà tranchée.
        if (!rule || rule.origin !== 'signal' || rule.confirmed) return false;
        const now = this.deps.now?.() ?? Date.now();
        const from = rule.when.from ?? '';
        const oldCategory = rule.then.category;
        const oldLabel =
            oldCategory !== null ? this.labelOf(oldCategory) : null;

        if (action === 'confirm') {
            if (oldCategory === null) return false;
            this.deps.rules.upsert({ ...rule, confirmed: true });
            if (this.archives(oldCategory) && oldLabel) {
                await this.relabelQuarantine(
                    `from:${from} label:"${oldLabel}" in:inbox`,
                    { archive: true },
                );
            }
            this.journalQuarantine(action, from, oldCategory);
        } else if (action === 'correct') {
            const category = opts.category;
            if (!category) return false;
            // catégorie fournie mais inconnue : requête mal formée, pas une
            // règle absente — la route la distingue d'un 404 par ce message.
            if (!this.validIds().has(category)) {
                throw new Error('catégorie inconnue');
            }
            const newLabel = this.labelOf(category);
            this.deps.rules.upsert({
                ...rule,
                then: { category },
                origin: 'correction',
                confirmed: true,
            });
            const query = oldLabel
                ? `from:${from} label:"${oldLabel}"`
                : `from:${from}`;
            await this.relabelQuarantine(query, {
                add: [newLabel],
                remove: oldLabel ? [oldLabel] : [],
                archive: this.archives(category),
            });
            for (const p of this.state.proposals) {
                if (p.ruleId === ruleId) {
                    p.category = category;
                    p.proposeArchive = this.archives(category);
                }
            }
            this.journalQuarantine(action, from, category);
        } else {
            this.deps.rules.remove(ruleId);
            // une règle négative pour cette adresse existe déjà (rejet
            // antérieur, ou règle posée à la main) : ne pas en dupliquer une
            // seconde, qui laisserait deux règles concurrentes coexister.
            const existingNegative = ruleFor(this.deps.rules.all(), from);
            if (!existingNegative || existingNegative.then.category !== null) {
                this.deps.rules.upsert(
                    newRule({
                        when: { from },
                        category: null,
                        origin: 'user',
                        confirmed: true,
                        now,
                    }),
                );
            }
            if (oldLabel) {
                await this.relabelQuarantine(
                    `from:${from} label:"${oldLabel}"`,
                    { remove: [oldLabel] },
                );
            }
            this.state.proposals = this.state.proposals.filter(
                (p) => p.ruleId !== ruleId,
            );
            this.journalQuarantine(action, from, oldCategory ?? '');
        }
        saveTriage(this.state, this.stateFile);
        return true;
    }

    /** Relabel best-effort d'un lot de mails déjà en boîte (rattrapage de quarantaine) — un échec par mail n'interrompt pas les autres, plafonné à 100 comme les autres relectures rétroactives. */
    private async relabelQuarantine(
        query: string,
        args: { add?: string[]; remove?: string[]; archive?: boolean },
    ): Promise<void> {
        const mails = parseMetaList(
            await this.deps.deviceHandler('list_messages_meta', {
                query,
                maxResults: 100,
            }),
        );
        for (const m of mails) {
            try {
                await this.deps.deviceHandler('modify_labels', {
                    messageId: m.id,
                    ...args,
                });
            } catch (err) {
                Logger.warn(`concierge: quarantaine relabel ${m.id} — ${err}`);
            }
        }
    }

    /** Une entrée par décision de quarantaine — même journal que le tri, sujet et mailId vides (l'action porte sur un expéditeur, pas un mail précis). */
    private journalQuarantine(
        action: 'confirm' | 'correct' | 'reject',
        from: string,
        category: string,
    ): void {
        try {
            this.deps.journal.add({
                at: this.deps.now?.() ?? Date.now(),
                mailId: '',
                from,
                subject: '',
                category,
                stage: 'rule',
                reason: `quarantaine : ${action}`,
                applied: true,
            });
        } catch (err) {
            Logger.warn(`concierge: journal quarantaine ${from} — ${err}`);
        }
    }

    /** Pile à lire côté Gmail (pas seulement l'approximation locale de `readingCount()`) — `GET /mail/reading`. */
    async reading(limit = 50): Promise<
        Array<{
            id: string;
            from: string;
            subject: string;
            date: string;
            snippet: string;
        }>
    > {
        const raw = await this.deps.deviceHandler('list_messages_meta', {
            query: 'label:"Yui/A lire" is:unread',
            maxResults: limit,
        });
        let list: unknown = raw;
        if (typeof raw === 'string') {
            try {
                list = JSON.parse(raw);
            } catch {
                return [];
            }
        }
        if (!Array.isArray(list)) return [];
        const out: Array<{
            id: string;
            from: string;
            subject: string;
            date: string;
            snippet: string;
        }> = [];
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const o = item as Record<string, unknown>;
            const id = typeof o.id === 'string' ? o.id : '';
            if (!id) continue;
            out.push({
                id,
                from: typeof o.from === 'string' ? o.from : '',
                subject: typeof o.subject === 'string' ? o.subject : '',
                date: typeof o.date === 'string' ? o.date : '',
                snippet: typeof o.snippet === 'string' ? o.snippet : '',
            });
        }
        return out;
    }

    /** Accusé de lecture depuis la pile (n'affecte ni label ni tri). */
    async markRead(mailId: string): Promise<void> {
        await this.deps.deviceHandler('mark_read', { messageId: mailId });
    }

    /**
     * Scanne la boîte et classe les mails non encore traités.
     * `query` permet le nettoyage d'arriéré (ex: "in:inbox older_than:6m").
     */
    async scan(
        query = 'in:inbox newer_than:2d',
        max = 40,
    ): Promise<{ scanned: number; classified: number; doubts: number }> {
        const now = this.deps.now?.() ?? Date.now();
        const mails = parseMetaList(
            await this.deps.deviceHandler('list_messages_meta', {
                query,
                maxResults: max,
            }),
        );
        const seen = new Set(this.state.processedIds);
        const known = new Set(this.state.proposals.map((p) => p.mailId));
        const fresh = mails.filter((m) => !seen.has(m.id) && !known.has(m.id));
        if (!fresh.length) {
            this.state.lastScanAt = now;
            saveTriage(this.state, this.stateFile);
            return { scanned: mails.length, classified: 0, doubts: 0 };
        }

        const valid = this.validIds();
        let concluded = 0;

        // 1-2. règles confirmées puis signaux (0 token). `rules.all()` est relu
        // à chaque mail : une règle de quarantaine apprise sur le premier mail
        // d'un expéditeur doit déjà compter pour le second du même sondage.
        const candidates: ConciergeMail[] = [];
        for (const m of fresh) {
            const v = deterministicVerdict(m, this.deps.rules.all(), valid);
            if (!v) {
                candidates.push(m);
                continue;
            }
            if (v.stage === 'rule' && v.ruleId) {
                this.deps.rules.recordHit(v.ruleId, now);
                const proposal = this.conclude(m, {
                    category: v.category,
                    via: 'rule',
                    stage: 'rule',
                    ruleId: v.ruleId,
                });
                // Une règle confirmée = déjà validée par Jérémy : application
                // directe, archive comprise si la catégorie le prévoit.
                try {
                    await this.applyProposal(proposal, { auto: true });
                } catch (err) {
                    Logger.warn(`concierge: règle ${m.id} — ${err}`);
                }
                this.journal(proposal, { ruleId: v.ruleId });
                concluded++;
            } else if (v.stage === 'signal') {
                let ruleId = v.ruleId;
                if (ruleId) {
                    this.deps.rules.recordHit(ruleId, now);
                } else {
                    const learned = ruleFromSignal(m.from, v.category, now);
                    this.deps.rules.upsert(learned);
                    // le mail fondateur compte comme premier hit de la règle
                    this.deps.rules.recordHit(learned.id, now);
                    ruleId = learned.id;
                }
                const proposal = this.conclude(m, {
                    category: v.category,
                    via: 'signal',
                    stage: 'signal',
                    ruleId,
                    // jamais d'archive sur un signal : la règle n'est pas confirmée
                    proposeArchive: false,
                });
                await this.labelOnly(proposal, `signal ${m.id}`);
                this.journal(proposal, { ruleId, signal: v.signal });
                concluded++;
            } else {
                candidates.push(m);
            }
        }

        // 3. LLM — borné par sondage ; les reportés ne sont pas touchés
        // (ni proposition ni processedIds) et reviennent au prochain scan.
        const { now: toLlm, later } = splitForLlm(candidates, LLM_PER_POLL);
        if (later.length) {
            Logger.info(
                `concierge: ${later.length} mail(s) reportés au prochain poll`,
            );
        }

        // corps des mails (le sujet seul trompe : « Jérémy, c'est Jimmy… »)
        if (this.deps.readBodies !== false) {
            for (const m of toLlm) {
                try {
                    const full = await this.deps.deviceHandler('get_email', {
                        messageId: m.id,
                    });
                    if (typeof full === 'string') m.body = extractBody(full);
                } catch {
                    /* aperçu seul */
                }
            }
        }

        const system = buildClassifySystem(
            this.categories(),
            this.deps.getPromptRules?.() ?? [],
        );
        const classified: Array<{ mail: ConciergeMail; item: ClassifyItem }> =
            [];
        const failed: ConciergeMail[] = [];
        for (let i = 0; i < toLlm.length; i += LLM_BATCH) {
            const batch = toLlm.slice(i, i + LLM_BATCH);
            let items: Array<ClassifyItem | null>;
            try {
                const reply = await this.deps.complete(
                    system,
                    buildClassifyUser(batch),
                );
                items = parseClassifyReply(reply, batch.length, valid);
            } catch (err) {
                Logger.warn(`concierge: classification LLM échouée — ${err}`);
                items = new Array(batch.length).fill(null);
            }
            batch.forEach((mail, j) => {
                const item = items[j];
                if (item) classified.push({ mail, item });
                else failed.push(mail);
            });
        }

        // propositions, doutes, auto-application
        const auto = new Set(this.deps.getAutoCategories());
        const newDoubts: TriageDoubt[] = [];
        for (const c of classified) {
            delete this.state.fallbackTries[c.mail.id];
            const proposal = this.conclude(c.mail, {
                category: c.item.category,
                via: 'llm',
                stage: 'llm',
                urgency: c.item.urgency,
                reason: c.item.reason,
                ...(c.item.doubt ? { doubt: true } : {}),
            });
            if (c.item.doubt) {
                const d: TriageDoubt = {
                    id: `${now.toString(36)}-${c.mail.id.slice(-6)}`,
                    mailId: c.mail.id,
                    from: c.mail.from,
                    subject: c.mail.subject,
                    category: c.item.category,
                    reason: c.item.doubt.reason,
                    alternatives: c.item.doubt.alternatives,
                    suggestions: c.item.doubt.suggestions,
                    at: now,
                };
                this.state.doubts.push(d);
                newDoubts.push(d);
                // un doute n'est jamais auto-appliqué
            } else if (auto.has(c.item.category)) {
                // les autoCategories sont opt-in explicites : application directe
                try {
                    await this.applyProposal(proposal, { auto: true });
                } catch (err) {
                    Logger.warn(`concierge: application ${c.mail.id} — ${err}`);
                }
            }
            this.journal(proposal);
            concluded++;
        }

        // 4. repli : un mail que le LLM n'a pas su lire est retenté aux
        // sondages suivants, puis rangé en lecture plutôt que bloqué à jamais.
        for (const m of failed) {
            const tries = (this.state.fallbackTries[m.id] ?? 0) + 1;
            if (tries < FALLBACK_MAX_TRIES) {
                this.state.fallbackTries[m.id] = tries;
                continue;
            }
            delete this.state.fallbackTries[m.id];
            const proposal = this.conclude(m, {
                category: fallbackVerdict().category,
                via: 'fallback',
                stage: 'fallback',
                proposeArchive: false,
            });
            await this.labelOnly(proposal, `repli ${m.id}`);
            this.journal(proposal);
            concluded++;
        }

        this.state.lastScanAt = now;
        saveTriage(this.state, this.stateFile);
        Logger.info(
            `concierge: scan "${query}" → ${fresh.length} nouveau(x), ${concluded} classé(s), ${newDoubts.length} doute(s)`,
        );
        if (newDoubts.length) {
            try {
                this.deps.onDoubts?.(newDoubts);
            } catch {
                /* best-effort */
            }
        }
        return {
            scanned: mails.length,
            classified: concluded,
            doubts: newDoubts.length,
        };
    }

    /** Enregistre une conclusion : proposition + mail marqué traité. */
    private conclude(
        m: ConciergeMail,
        v: Pick<TriageProposal, 'category' | 'via' | 'stage'> &
            Partial<
                Pick<
                    TriageProposal,
                    'ruleId' | 'urgency' | 'reason' | 'proposeArchive' | 'doubt'
                >
            >,
    ): TriageProposal {
        const proposal: TriageProposal = {
            mailId: m.id,
            from: m.from,
            subject: m.subject,
            category: v.category,
            via: v.via,
            stage: v.stage,
            ...(v.ruleId ? { ruleId: v.ruleId } : {}),
            ...(v.urgency ? { urgency: v.urgency } : {}),
            ...(v.reason !== undefined ? { reason: v.reason } : {}),
            proposeArchive: v.proposeArchive ?? this.archives(v.category),
            ...(v.doubt ? { doubt: true } : {}),
        };
        this.state.proposals.push(proposal);
        this.state.processedIds.push(m.id);
        this.state.stats.classified++;
        return proposal;
    }

    /** Label seul, sans archive — étages signal et repli (rien de confirmé par Jérémy). */
    private async labelOnly(p: TriageProposal, what: string): Promise<void> {
        try {
            await this.deps.deviceHandler('modify_labels', {
                messageId: p.mailId,
                add: [this.labelOf(p.category)],
            });
            p.appliedAt = this.deps.now?.() ?? Date.now();
            p.auto = true;
            this.state.stats.applied++;
        } catch (err) {
            Logger.warn(`concierge: ${what} — ${err}`);
        }
    }

    /** Une décision par mail conclu ; `applied` = un label vient d'être posé. Best-effort. */
    private journal(
        p: TriageProposal,
        extra: { ruleId?: string; signal?: string } = {},
    ): void {
        try {
            this.deps.journal.add({
                at: this.deps.now?.() ?? Date.now(),
                mailId: p.mailId,
                from: p.from,
                subject: p.subject,
                category: p.category,
                stage: p.stage ?? 'llm',
                ...(extra.ruleId ? { ruleId: extra.ruleId } : {}),
                ...(extra.signal ? { signal: extra.signal } : {}),
                ...(p.urgency ? { urgency: p.urgency } : {}),
                ...(p.reason ? { reason: p.reason } : {}),
                applied: p.appliedAt !== undefined,
            });
        } catch (err) {
            Logger.warn(`concierge: journal ${p.mailId} — ${err}`);
        }
    }

    private async applyProposal(
        p: TriageProposal,
        opts: { auto?: boolean } = {},
    ): Promise<void> {
        await this.deps.deviceHandler('modify_labels', {
            messageId: p.mailId,
            add: [this.labelOf(p.category)],
            archive: p.proposeArchive,
        });
        p.appliedAt = this.deps.now?.() ?? Date.now();
        p.auto = opts.auto === true;
        this.state.stats.applied++;
    }

    /** Applique les propositions en attente (toutes, ou d'une catégorie). */
    async apply(filter?: {
        category?: MailCategory;
        mailIds?: string[];
    }): Promise<number> {
        let n = 0;
        for (const p of this.pending()) {
            if (filter?.category && p.category !== filter.category) continue;
            if (filter?.mailIds && !filter.mailIds.includes(p.mailId)) continue;
            try {
                await this.applyProposal(p);
                n++;
            } catch (err) {
                Logger.warn(`concierge: application ${p.mailId} — ${err}`);
            }
        }
        saveTriage(this.state, this.stateFile);
        return n;
    }

    /**
     * Une correction promeut la règle de quarantaine de l'adresse exacte si
     * elle existe (même id, désormais confirmée), sinon apprend une règle de
     * domaine. Une règle de correction déjà apprise sur ce domaine est
     * remplacée : deux règles concurrentes laisseraient toujours gagner la
     * plus ancienne, et la seconde correction resterait lettre morte.
     */
    private learnCorrection(from: string, category: MailCategory): void {
        const now = this.deps.now?.() ?? Date.now();
        const all = this.deps.rules.all();
        const exact = ruleFor(all, from);
        if (exact && !exact.confirmed) {
            this.deps.rules.upsert({
                ...exact,
                then: { category },
                origin: 'correction',
                confirmed: true,
            });
            return;
        }
        const domain = senderDomain(from);
        const fresh = ruleFromCorrection(from, category, now);
        const previous = all.find(
            (r) =>
                r.origin === 'correction' &&
                Object.keys(r.when).length === 1 &&
                r.when.from === domain,
        );
        this.deps.rules.upsert(
            previous
                ? { ...fresh, id: previous.id, createdAt: previous.createdAt }
                : fresh,
        );
    }

    /**
     * Correction : reclasse un mail ET apprend la règle (domaine expéditeur).
     * C'est la boucle d'apprentissage — la prochaine fois, 0 token.
     */
    async correct(mailId: string, category: MailCategory): Promise<boolean> {
        const p = this.state.proposals.find((x) => x.mailId === mailId);
        if (!p || !this.validIds().has(category)) return false;
        const previous = this.labelOf(p.category);
        const previousCategory = p.category;
        p.category = category;
        p.proposeArchive = this.archives(category);
        p.doubt = false;
        try {
            await this.deps.deviceHandler('modify_labels', {
                messageId: p.mailId,
                add: [this.labelOf(category)],
                remove: p.appliedAt ? [previous] : [],
                archive: p.proposeArchive,
            });
            p.appliedAt = this.deps.now?.() ?? Date.now();
            p.auto = false;
        } catch (err) {
            Logger.warn(`concierge: correction ${mailId} — ${err}`);
        }
        this.state.stats.corrected++;
        this.learnCorrection(p.from, category);
        try {
            this.deps.onCorrected?.(mailId, previousCategory, category);
        } catch {
            /* best-effort : la correction elle-même a déjà réussi */
        }
        // Un doute ouvert sur ce mail est tranché par la correction.
        for (const d of this.state.doubts) {
            if (d.mailId === mailId && !d.resolvedAt) {
                d.resolvedAt = this.deps.now?.() ?? Date.now();
            }
        }
        saveTriage(this.state, this.stateFile);
        return true;
    }

    /**
     * Tranche un doute : catégorie retenue (→ correction + règle expéditeur)
     * et suggestions acceptées (règles de prompt / nouvelle catégorie pour
     * la prochaine analyse). `accept` = index des suggestions acceptées.
     */
    async resolveDoubt(
        doubtId: string,
        opts: { category?: MailCategory; accept?: number[] },
    ): Promise<boolean> {
        const d = this.state.doubts.find((x) => x.id === doubtId);
        if (!d) return false;
        for (const idx of opts.accept ?? []) {
            const s = d.suggestions[idx];
            if (!s) continue;
            if (s.kind === 'category' && s.id) {
                this.deps.addCustomCategory?.({
                    id: s.id,
                    label: s.label ?? `Yui/${s.id}`,
                    description: s.text,
                    archive: s.archive === true,
                });
            } else if (s.kind === 'rule') {
                this.deps.addPromptRule?.(s.text);
            }
        }
        if (opts.category) {
            await this.correct(d.mailId, opts.category);
        }
        d.resolvedAt = this.deps.now?.() ?? Date.now();
        saveTriage(this.state, this.stateFile);
        return true;
    }
}
