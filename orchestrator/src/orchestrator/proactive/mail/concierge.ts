// Concierge courrier — trie la boîte Gmail en continu.
//
// Chaque mail entrant est classé (règles apprises d'abord — 0 token —, LLM
// par lots sinon) et matérialisé en label Gmail « Yui/… » : le tri est
// visible partout, pas enfermé dans l'app. Mode PROPOSITIONS par défaut :
// rien n'est appliqué sans validation, sauf les catégories listées dans
// `concierge.autoCategories` (newsletters/promos une fois la confiance
// acquise). Chaque correction devient une règle par expéditeur.
//
// Sécurité : on ne SUPPRIME jamais — au pire on archive (réversible), et
// uniquement pour les catégories d'archivage (newsletter/promo).
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';
import { parseSearchOutput } from '../watchers/deliveries';
import type { ParsedMail } from '../watchers/deliveries';
import type { ConciergeRule } from '../types';

export type MailCategory =
    | 'action'
    | 'lire'
    | 'admin'
    | 'commande'
    | 'newsletter'
    | 'promo';

export const CATEGORIES: MailCategory[] = [
    'action',
    'lire',
    'admin',
    'commande',
    'newsletter',
    'promo',
];

export const CATEGORY_LABELS: Record<MailCategory, string> = {
    action: 'Yui/Action',
    lire: 'Yui/A lire',
    admin: 'Yui/Admin',
    commande: 'Yui/Commandes',
    newsletter: 'Yui/Newsletters',
    promo: 'Yui/Promos',
};

/** Catégories dont la validation propose aussi l'archivage. */
export const ARCHIVE_CATEGORIES: MailCategory[] = ['newsletter', 'promo'];

export interface TriageProposal {
    mailId: string;
    from: string;
    subject: string;
    category: MailCategory;
    via: 'rule' | 'llm';
    proposeArchive: boolean;
    /** Posé quand le label a été réellement appliqué. */
    appliedAt?: number;
    /** Appliqué automatiquement (catégorie en autoCategories). */
    auto?: boolean;
}

export interface TriageState {
    proposals: TriageProposal[];
    /** Ids déjà traités (borné) — évite de reclasser au poll suivant. */
    processedIds: string[];
    stats: { classified: number; applied: number; corrected: number };
    lastScanAt?: number;
}

const STATE_FILE = dataPath('mail-triage.json');
const MAX_PROCESSED = 1000;
const MAX_PROPOSALS = 200;
const BATCH_SIZE = 12;

export function loadTriage(file: string = STATE_FILE): TriageState {
    try {
        if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return {
                proposals: Array.isArray(raw.proposals) ? raw.proposals : [],
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
): MailCategory | null {
    if (!rules) return null;
    const lc = from.toLowerCase();
    for (const r of rules) {
        if (
            r.match &&
            lc.includes(r.match.toLowerCase()) &&
            (CATEGORIES as string[]).includes(r.category)
        ) {
            return r.category as MailCategory;
        }
    }
    return null;
}

/** Domaine de l'expéditeur ("Zalando <news@mail.zalando.fr>" → "mail.zalando.fr"). */
export function senderDomain(from: string): string {
    const m = /@([\w.-]+)/.exec(from);
    return (m?.[1] ?? from).toLowerCase();
}

const CLASSIFY_SYSTEM = `Tu tries la boîte mail de Jérémy. Pour chaque mail numéroté, choisis UNE catégorie :
- "action" : demande une réponse ou une démarche de sa part (relance, facture à payer, RDV à confirmer, document à renvoyer).
- "lire" : mérite d'être lu mais sans action (info personnelle, réponse attendue, suivi de dossier).
- "admin" : administratif à garder sans lecture urgente (confirmations, reçus, attestations, banque).
- "commande" : achats/livraisons (confirmations de commande, expédition, factures d'achat en ligne).
- "newsletter" : lettres d'information éditoriales auxquelles il est abonné.
- "promo" : marketing pur, soldes, relances commerciales non sollicitées.
Réponds UNIQUEMENT en JSON : [{"i":1,"category":"promo"}, ...] — un objet par mail, dans l'ordre.`;

/** Prompt utilisateur du lot. Pur, testé. */
export function buildClassifyUser(mails: ParsedMail[]): string {
    return mails
        .map(
            (m, i) =>
                `${i + 1}. De: ${m.from}\n   Objet: ${
                    m.subject
                }\n   Aperçu: ${m.snippet.slice(0, 150)}`,
        )
        .join('\n');
}

/** Parse la réponse du LLM — null par mail illisible. Pur, testé. */
export function parseClassifyReply(
    raw: string,
    count: number,
): Array<MailCategory | null> {
    const out: Array<MailCategory | null> = new Array(count).fill(null);
    const m = /\[[\s\S]*\]/.exec(raw);
    if (!m) return out;
    try {
        const arr = JSON.parse(m[0]);
        if (!Array.isArray(arr)) return out;
        for (const item of arr) {
            const i = Number(item?.i) - 1;
            const cat = String(item?.category ?? '');
            if (i >= 0 && i < count && (CATEGORIES as string[]).includes(cat)) {
                out[i] = cat as MailCategory;
            }
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
    now?: () => number;
}

export class MailConcierge {
    private state: TriageState;

    constructor(private deps: ConciergeDeps, stateFile?: string) {
        this.stateFile = stateFile ?? STATE_FILE;
        this.state = loadTriage(this.stateFile);
    }
    private stateFile: string;

    getState(): TriageState {
        return this.state;
    }

    /** Propositions en attente (non appliquées). */
    pending(): TriageProposal[] {
        return this.state.proposals.filter((p) => !p.appliedAt);
    }

    /**
     * Scanne la boîte et classe les mails non encore traités.
     * `query` permet le nettoyage d'arriéré (ex: "in:inbox older_than:6m").
     */
    async scan(
        query = 'in:inbox newer_than:2d',
        max = 40,
    ): Promise<{
        scanned: number;
        classified: number;
    }> {
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
            return { scanned: mails.length, classified: 0 };
        }

        // 1. règles apprises (0 token)
        const rules = this.deps.getRules();
        const needLlm: ParsedMail[] = [];
        const classified: Array<{
            mail: ParsedMail;
            category: MailCategory;
            via: 'rule' | 'llm';
        }> = [];
        for (const m of fresh) {
            const cat = applyRules(rules, m.from);
            if (cat) classified.push({ mail: m, category: cat, via: 'rule' });
            else needLlm.push(m);
        }

        // 2. LLM par lots
        for (let i = 0; i < needLlm.length; i += BATCH_SIZE) {
            const batch = needLlm.slice(i, i + BATCH_SIZE);
            try {
                const reply = await this.deps.complete(
                    CLASSIFY_SYSTEM,
                    buildClassifyUser(batch),
                );
                const cats = parseClassifyReply(reply, batch.length);
                batch.forEach((mail, j) => {
                    const category = cats[j];
                    if (category)
                        classified.push({ mail, category, via: 'llm' });
                    // Mail illisible pour le LLM → on le laisse pour un
                    // prochain scan (pas marqué traité).
                });
            } catch (err) {
                Logger.warn(`concierge: classification LLM échouée — ${err}`);
            }
        }

        // 3. propositions + auto-application
        const auto = new Set(this.deps.getAutoCategories());
        for (const c of classified) {
            const proposal: TriageProposal = {
                mailId: c.mail.id,
                from: c.mail.from,
                subject: c.mail.subject,
                category: c.category,
                via: c.via,
                proposeArchive: ARCHIVE_CATEGORIES.includes(c.category),
            };
            this.state.proposals.push(proposal);
            this.state.processedIds.push(c.mail.id);
            this.state.stats.classified++;
            if (auto.has(c.category) || c.via === 'rule') {
                // Une règle apprise = déjà validée par une correction ; les
                // autoCategories sont opt-in explicites. Application directe.
                await this.applyProposal(proposal, { auto: true });
            }
        }
        this.state.lastScanAt = now;
        saveTriage(this.state, this.stateFile);
        Logger.info(
            `concierge: scan "${query}" → ${fresh.length} nouveau(x), ${classified.length} classé(s)`,
        );
        return { scanned: mails.length, classified: classified.length };
    }

    private async applyProposal(
        p: TriageProposal,
        opts: { auto?: boolean } = {},
    ): Promise<void> {
        await this.deps.deviceHandler('modify_labels', {
            messageId: p.mailId,
            add: [CATEGORY_LABELS[p.category]],
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
        if (!p) return false;
        const previous = CATEGORY_LABELS[p.category];
        p.category = category;
        p.proposeArchive = ARCHIVE_CATEGORIES.includes(category);
        try {
            await this.deps.deviceHandler('modify_labels', {
                messageId: p.mailId,
                add: [CATEGORY_LABELS[category]],
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
        saveTriage(this.state, this.stateFile);
        return true;
    }
}
