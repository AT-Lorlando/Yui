import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';

export type RuleOrigin = 'user' | 'correction' | 'signal';

export interface MailRule {
    id: string;
    when: { from?: string; subject?: string; header?: string };
    then: { category: string | null }; // null = règle négative (bloque les signaux, n'attribue rien)
    origin: RuleOrigin;
    confirmed: boolean;
    hits: number;
    lastHitAt?: number;
    createdAt: number;
}

export interface RuleMail {
    id: string;
    from: string;
    subject: string;
    headers: Record<string, string>;
    snippet: string;
}

export interface RulesFile {
    version: 1;
    rules: MailRule[];
}

/** Domaines grand public : une règle « tout ce domaine » y classerait le courrier de n'importe qui — l'adresse complète est exigée. */
export const PUBLIC_DOMAINS: ReadonlySet<string> = new Set([
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'outlook.fr',
    'hotmail.com',
    'hotmail.fr',
    'live.com',
    'live.fr',
    'msn.com',
    'yahoo.com',
    'yahoo.fr',
    'icloud.com',
    'me.com',
    'mac.com',
    'orange.fr',
    'wanadoo.fr',
    'free.fr',
    'sfr.fr',
    'laposte.net',
    'bbox.fr',
    'protonmail.com',
    'proton.me',
]);

/** Adresse de l'expéditeur ("Nom <a@b.c>" → "a@b.c") ; le nom affiché ne compte jamais. */
export function senderAddress(from: string): string {
    const m = /<([^>]+)>/.exec(from);
    return (m?.[1] ?? from).trim().toLowerCase();
}

/** Partie locale de l'adresse ("a@b.c" → "a"), pour les signaux type no-reply. */
export function senderLocalPart(from: string): string {
    const address = senderAddress(from);
    const at = address.indexOf('@');
    return at >= 0 ? address.slice(0, at) : address;
}

/** Domaine de l'expéditeur ("Zalando <news@mail.zalando.fr>" → "mail.zalando.fr"). Déplacé depuis concierge.ts, ré-exporté de là pour ne pas casser son API. */
export function senderDomain(from: string): string {
    const m = /@([\w.-]+)/.exec(from);
    return (m?.[1] ?? from).toLowerCase();
}

// Une regex de sujet invalide ne doit jamais faire planter le tri des mails —
// on ne prévient qu'une fois par règle pour ne pas noyer les logs.
const warnedInvalidSubject = new Set<string>();

/** ET des conditions présentes dans `when` ; toutes absentes = ne matche jamais. */
export function matchRule(rule: MailRule, mail: RuleMail): boolean {
    const conditions: boolean[] = [];

    if (rule.when.from) {
        const needle = rule.when.from.toLowerCase();
        const address = senderAddress(mail.from);
        const raw = mail.from.toLowerCase();
        // adresse exacte ou domaine partiel : les deux formes doivent marcher
        conditions.push(address.includes(needle) || raw.includes(needle));
    }

    if (rule.when.subject) {
        try {
            const re = new RegExp(rule.when.subject, 'i');
            conditions.push(re.test(mail.subject));
        } catch (e) {
            if (!warnedInvalidSubject.has(rule.id)) {
                warnedInvalidSubject.add(rule.id);
                Logger.warn(
                    `mail rule ${
                        rule.id
                    }: expression régulière de sujet invalide "${
                        rule.when.subject
                    }" (${(e as Error).message})`,
                );
            }
            return false;
        }
    }

    if (rule.when.header) {
        const needle = rule.when.header.toLowerCase();
        conditions.push(
            Object.keys(mail.headers).some((k) => k.toLowerCase() === needle),
        );
    }

    if (conditions.length === 0) return false;
    return conditions.every(Boolean);
}

const ORIGIN_RANK: Record<RuleOrigin, number> = {
    user: 0,
    correction: 1,
    signal: 2,
};

/** user avant correction avant signal, puis la plus ancienne d'abord (premier appris, premier essayé). */
export function sortRules(rules: MailRule[]): MailRule[] {
    return [...rules].sort((a, b) => {
        const byOrigin = ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin];
        if (byOrigin !== 0) return byOrigin;
        return a.createdAt - b.createdAt;
    });
}

/** Première règle qui matche, toutes origines confondues (confirmée ou pas — c'est à l'appelant de filtrer `confirmed` s'il veut conclure). */
export function firstMatch(rules: MailRule[], mail: RuleMail): MailRule | null {
    for (const rule of sortRules(rules)) {
        if (matchRule(rule, mail)) return rule;
    }
    return null;
}

/** Règle dont `when` = { from: adresse exacte } et rien d'autre — pour retrouver/écraser la règle d'un expéditeur précis. */
export function ruleFor(rules: MailRule[], from: string): MailRule | null {
    const address = senderAddress(from);
    for (const rule of rules) {
        const keys = Object.keys(rule.when);
        if (keys.length === 1 && rule.when.from === address) return rule;
    }
    return null;
}

export function newRule(input: {
    when: MailRule['when'];
    category: string | null;
    origin: RuleOrigin;
    confirmed: boolean;
    now: number;
}): MailRule {
    return {
        id: `r-${crypto.randomBytes(3).toString('hex')}`,
        when: input.when,
        then: { category: input.category },
        origin: input.origin,
        confirmed: input.confirmed,
        hits: 0,
        createdAt: input.now,
    };
}

/** Correction manuelle : on généralise au domaine (comme aujourd'hui), et on la traite comme acquise. */
export function ruleFromCorrection(
    from: string,
    category: string,
    now: number,
): MailRule {
    return newRule({
        when: { from: senderDomain(from) },
        category,
        origin: 'correction',
        confirmed: true,
        now,
    });
}

/** Signal automatique (en-têtes, local part…) : adresse exacte, pas encore confirmée — un signal ne doit pas décider seul sans repasser devant l'humain. */
export function ruleFromSignal(
    from: string,
    category: string,
    now: number,
): MailRule {
    return newRule({
        when: { from: senderAddress(from) },
        category,
        origin: 'signal',
        confirmed: false,
        now,
    });
}

export function validateRuleInput(
    raw: unknown,
    validCategories: Set<string>,
):
    | { ok: true; rule: Omit<MailRule, 'id' | 'hits' | 'createdAt'> }
    | { ok: false; error: string } {
    if (typeof raw !== 'object' || raw === null) {
        return { ok: false, error: 'règle invalide' };
    }
    const obj = raw as Record<string, unknown>;

    const when = obj.when;
    if (typeof when !== 'object' || when === null) {
        return { ok: false, error: 'condition manquante' };
    }
    const w = when as Record<string, unknown>;
    const from =
        typeof w.from === 'string' && w.from.trim() ? w.from.trim() : undefined;
    const subject =
        typeof w.subject === 'string' && w.subject.trim()
            ? w.subject.trim()
            : undefined;
    const header =
        typeof w.header === 'string' && w.header.trim()
            ? w.header.trim()
            : undefined;
    // une règle sans aucune condition matcherait tout, ou rien selon le sens qu'on lui donne — on la refuse plutôt que deviner
    if (!from && !subject && !header) {
        return {
            ok: false,
            error: 'au moins une condition (expéditeur, sujet ou en-tête) est requise',
        };
    }
    if (from && !from.includes('@') && PUBLIC_DOMAINS.has(from.toLowerCase())) {
        return {
            ok: false,
            error: "domaine grand public : précise l'adresse complète",
        };
    }
    if (subject) {
        try {
            new RegExp(subject, 'i');
        } catch {
            return {
                ok: false,
                error: 'expression régulière de sujet invalide',
            };
        }
    }

    const then = obj.then;
    if (typeof then !== 'object' || then === null) {
        return { ok: false, error: 'catégorie manquante' };
    }
    const category = (then as Record<string, unknown>).category;
    // null = règle négative, toujours valide ; sinon la catégorie doit exister
    if (
        category !== null &&
        (typeof category !== 'string' || !validCategories.has(category))
    ) {
        return { ok: false, error: 'catégorie inconnue' };
    }

    return {
        ok: true,
        rule: {
            when: {
                ...(from ? { from } : {}),
                ...(subject ? { subject } : {}),
                ...(header ? { header } : {}),
            },
            then: { category: (category ?? null) as string | null },
            origin: 'user',
            confirmed: true,
        },
    };
}

/** Migration des anciennes règles `{match, category}` (matching = domaine, comme senderDomain) — ids déterministes pour un résultat idempotent. */
export function migrateLegacyRules(
    legacy: Array<{ match: string; category: string }>,
    now: number,
): MailRule[] {
    return legacy.map((entry, i) => ({
        id: `r-legacy-${i}`,
        when: { from: entry.match },
        then: { category: entry.category },
        origin: 'correction',
        confirmed: true,
        hits: 0,
        createdAt: now,
    }));
}

/** Migration une seule fois : si le store existe déjà, la migration a eu lieu (ou l'utilisateur a démarré sans legacy) — ne jamais réécraser des règles apprises depuis. */
export function migrateRulesOnce(
    store: RuleStore,
    legacy: Array<{ match: string; category: string }> | undefined,
    now: number,
): number {
    if (store.exists() || !legacy || legacy.length === 0) return 0;
    const migrated = migrateLegacyRules(legacy, now);
    for (const rule of migrated) store.upsert(rule);
    return migrated.length;
}

export class RuleStore {
    private file: string;
    private rules: MailRule[] = [];

    constructor(file?: string) {
        this.file = file ?? RuleStore.defaultFile();
        this.load();
    }

    static defaultFile(): string {
        return dataPath('mail-rules.json');
    }

    /** Existence réelle sur disque au moment de l'appel (pas mise en cache) — sert à ne migrer le legacy qu'une fois. */
    exists(): boolean {
        return fs.existsSync(this.file);
    }

    all(): MailRule[] {
        return this.rules;
    }

    upsert(rule: MailRule): void {
        const i = this.rules.findIndex((r) => r.id === rule.id);
        if (i >= 0) this.rules[i] = rule;
        else this.rules.push(rule);
        this.save();
    }

    remove(id: string): boolean {
        const i = this.rules.findIndex((r) => r.id === id);
        if (i < 0) return false;
        this.rules.splice(i, 1);
        this.save();
        return true;
    }

    /** Remplace tout le fichier (édition JSON brut, tout-ou-rien côté appelant — validée avant d'arriver ici). */
    replaceAll(rules: MailRule[]): void {
        this.rules = rules;
        this.save();
    }

    recordHit(id: string, now: number): void {
        const rule = this.rules.find((r) => r.id === id);
        if (!rule) return;
        rule.hits += 1;
        rule.lastHitAt = now;
        this.save();
    }

    private load(): void {
        if (!fs.existsSync(this.file)) {
            this.rules = [];
            return;
        }
        try {
            const raw = fs.readFileSync(this.file, 'utf-8');
            const parsed = JSON.parse(raw) as RulesFile;
            this.rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
        } catch (e) {
            // fichier corrompu : on repart à vide plutôt que de planter le concierge au démarrage
            Logger.warn(`mail-rules.json illisible, réinitialisation : ${e}`);
            this.rules = [];
        }
    }

    private save(): void {
        // best-effort : une écriture qui échoue (disque plein, droits, parent
        // = fichier…) ne doit jamais faire planter le tri qui l'appelle
        // (upsert/recordHit) — la règle reste au moins en mémoire
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const data: RulesFile = { version: 1, rules: this.rules };
            fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
        } catch (e) {
            Logger.warn(`mail-rules.json non écrit : ${e}`);
        }
    }
}
