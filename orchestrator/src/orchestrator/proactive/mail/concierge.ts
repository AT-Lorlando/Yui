// Concierge courrier — trie la boîte Gmail en continu.
//
// Chaque mail entrant est classé (règles apprises d'abord — 0 token —, LLM
// par lots sinon, EN LISANT LE CORPS) et matérialisé en label Gmail « Yui/… » :
// le tri est visible partout, pas enfermé dans l'app. Mode PROPOSITIONS par
// défaut : rien n'est appliqué sans validation, sauf les catégories listées
// dans `concierge.autoCategories` et les règles apprises.
//
// Trois boucles d'apprentissage, du moins au plus cher :
//  1. règles par expéditeur (`concierge.rules`) — une correction en crée une ;
//  2. règles de prompt (`concierge.promptRules`, texte libre injecté dans le
//     prompt) et catégories personnalisées (`concierge.customCategories`) ;
//  3. les DOUTES : quand le LLM hésite, il le dit et propose des règles ou une
//     nouvelle catégorie ; l'app notifie, Jérémy tranche, et ce qu'il accepte
//     alimente 1 et 2 pour la prochaine analyse.
//
// Sécurité : on ne SUPPRIME jamais — au pire on archive (réversible), et
// uniquement pour les catégories d'archivage.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';
import { parseSearchOutput } from '../watchers/deliveries';
import type { ParsedMail } from '../watchers/deliveries';
import type { ConciergeRule, CustomCategory } from '../types';

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
    via: 'rule' | 'llm';
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
    stats: { classified: number; applied: number; corrected: number };
    lastScanAt?: number;
}

const STATE_FILE = dataPath('mail-triage.json');
const MAX_PROCESSED = 1000;
const MAX_PROPOSALS = 200;
const MAX_DOUBTS = 60;
const BATCH_SIZE = 8;
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
        stats: { classified: 0, applied: 0, corrected: 0 },
    };
}

export function saveTriage(st: TriageState, file: string = STATE_FILE): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
            file,
            JSON.stringify({
                ...st,
                proposals: st.proposals.slice(-MAX_PROPOSALS),
                doubts: st.doubts.slice(-MAX_DOUBTS),
                processedIds: st.processedIds.slice(-MAX_PROCESSED),
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

/** Domaine de l'expéditeur ("Zalando <news@mail.zalando.fr>" → "mail.zalando.fr"). */
export function senderDomain(from: string): string {
    const m = /@([\w.-]+)/.exec(from);
    return (m?.[1] ?? from).toLowerCase();
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

Si tu HÉSITES vraiment sur un mail (deux catégories plausibles, ou aucune ne colle), dis-le : "doubt":true, "reason" en une phrase, "alternatives" (les catégories envisagées), et propose dans "suggestions" ce qui te permettrait de trancher la prochaine fois — soit une règle en français à ajouter au prompt ({"kind":"rule","text":"Les alertes immobilières sont osef"}), soit une nouvelle catégorie ({"kind":"category","id":"immo","label":"Yui/Immobilier","text":"Annonces et alertes immobilières","archive":true}). Ne propose rien pour un mail sûr.

Réponds UNIQUEMENT en JSON : [{"i":1,"category":"promo"},{"i":2,"category":"lire","doubt":true,"reason":"…","alternatives":["lire","admin"],"suggestions":[…]}] — un objet par mail, dans l'ordre.`;
}

/** Prompt utilisateur du lot (corps compacté si fourni). Pur, testé. */
export function buildClassifyUser(
    mails: Array<ParsedMail & { body?: string }>,
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
            const entry: ClassifyItem = { category: cat };
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
    getRules: () => ConciergeRule[];
    addRule: (rule: ConciergeRule) => void;
    getAutoCategories: () => MailCategory[];
    getPromptRules?: () => string[];
    addPromptRule?: (text: string) => void;
    getCustomCategories?: () => CustomCategory[];
    addCustomCategory?: (c: CustomCategory) => void;
    /** Nouveaux doutes après un scan → l'app notifie (best-effort). */
    onDoubts?: (doubts: TriageDoubt[]) => void;
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

    /**
     * Scanne la boîte et classe les mails non encore traités.
     * `query` permet le nettoyage d'arriéré (ex: "in:inbox older_than:6m").
     */
    async scan(
        query = 'in:inbox newer_than:2d',
        max = 40,
    ): Promise<{ scanned: number; classified: number; doubts: number }> {
        const now = this.deps.now?.() ?? Date.now();
        const raw = await this.deps.deviceHandler('search_emails', {
            query,
            maxResults: max,
        });
        const mails = typeof raw === 'string' ? parseSearchOutput(raw) : [];
        const seen = new Set(this.state.processedIds);
        const known = new Set(this.state.proposals.map((p) => p.mailId));
        const fresh = mails.filter(
            (m) => m.id && !seen.has(m.id) && !known.has(m.id),
        );
        if (!fresh.length) {
            this.state.lastScanAt = now;
            saveTriage(this.state, this.stateFile);
            return { scanned: mails.length, classified: 0, doubts: 0 };
        }

        const valid = this.validIds();

        // 1. règles apprises (0 token)
        const rules = this.deps.getRules();
        const needLlm: Array<ParsedMail & { body?: string }> = [];
        const classified: Array<{
            mail: ParsedMail;
            item: ClassifyItem;
            via: 'rule' | 'llm';
        }> = [];
        for (const m of fresh) {
            const cat = applyRules(rules, m.from, valid);
            if (cat) {
                classified.push({
                    mail: m,
                    item: { category: cat },
                    via: 'rule',
                });
            } else {
                needLlm.push(m);
            }
        }

        // 2. corps des mails (le sujet seul trompe : « Jérémy, c'est Jimmy… »)
        if (this.deps.readBodies !== false) {
            for (const m of needLlm) {
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

        // 3. LLM par lots
        const system = buildClassifySystem(
            this.categories(),
            this.deps.getPromptRules?.() ?? [],
        );
        for (let i = 0; i < needLlm.length; i += BATCH_SIZE) {
            const batch = needLlm.slice(i, i + BATCH_SIZE);
            try {
                const reply = await this.deps.complete(
                    system,
                    buildClassifyUser(batch),
                );
                const items = parseClassifyReply(reply, batch.length, valid);
                batch.forEach((mail, j) => {
                    const item = items[j];
                    if (item) classified.push({ mail, item, via: 'llm' });
                    // Mail illisible pour le LLM → on le laisse pour un
                    // prochain scan (pas marqué traité).
                });
            } catch (err) {
                Logger.warn(`concierge: classification LLM échouée — ${err}`);
            }
        }

        // 4. propositions, doutes, auto-application
        const auto = new Set(this.deps.getAutoCategories());
        const newDoubts: TriageDoubt[] = [];
        for (const c of classified) {
            const proposal: TriageProposal = {
                mailId: c.mail.id,
                from: c.mail.from,
                subject: c.mail.subject,
                category: c.item.category,
                via: c.via,
                proposeArchive: this.archives(c.item.category),
                ...(c.item.doubt ? { doubt: true } : {}),
            };
            this.state.proposals.push(proposal);
            this.state.processedIds.push(c.mail.id);
            this.state.stats.classified++;
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
                continue; // un doute n'est jamais auto-appliqué
            }
            if (auto.has(c.item.category) || c.via === 'rule') {
                // Une règle apprise = déjà validée par une correction ; les
                // autoCategories sont opt-in explicites. Application directe.
                await this.applyProposal(proposal, { auto: true });
            }
        }
        this.state.lastScanAt = now;
        saveTriage(this.state, this.stateFile);
        Logger.info(
            `concierge: scan "${query}" → ${fresh.length} nouveau(x), ${classified.length} classé(s), ${newDoubts.length} doute(s)`,
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
            classified: classified.length,
            doubts: newDoubts.length,
        };
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
     * Correction : reclasse un mail ET apprend la règle (domaine expéditeur).
     * C'est la boucle d'apprentissage — la prochaine fois, 0 token.
     */
    async correct(mailId: string, category: MailCategory): Promise<boolean> {
        const p = this.state.proposals.find((x) => x.mailId === mailId);
        if (!p || !this.validIds().has(category)) return false;
        const previous = this.labelOf(p.category);
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
        this.deps.addRule({ match: senderDomain(p.from), category });
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
