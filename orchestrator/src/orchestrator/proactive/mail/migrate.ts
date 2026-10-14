import type { MailRule } from './rules';
import {
    newKeepSender,
    newSpamSender,
    type KeepSender,
    type SendersFile,
    type SpamSender,
} from './senders';

export interface MigrationReport {
    at: number;
    keep: number;
    spam: number;
    dropped: number;
    unknown: Array<{ match: string; proposed: 'spam' }>;
    names: Array<{ match: string; name: string }>;
}

export const SPAM_CATEGORIES = new Set([
    'promo',
    'newsletter',
    'osef',
    'notification',
]);
export const READ_ALWAYS_CATEGORIES = new Set([
    'action',
    'securite',
    'lire',
    'perso',
]);

const PUBLIC_DOMAINS = new Set([
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'yahoo.com',
    'yahoo.fr',
    'icloud.com',
    'me.com',
    'free.fr',
    'orange.fr',
    'wanadoo.fr',
    'sfr.fr',
    'laposte.net',
    'proton.me',
    'protonmail.com',
]);

/** Nom d'affichage : label de 2e niveau du domaine, majuscule initiale, ≤ 40 car. */
export function nameFromMatch(match: string): string {
    const m = match.trim().toLowerCase();
    const at = m.lastIndexOf('@');
    const domain = at >= 0 ? m.slice(at + 1) : m;
    const local = at > 0 ? m.slice(0, at) : '';
    if (local && PUBLIC_DOMAINS.has(domain)) {
        const l = local.replace(/\//g, '').trim();
        if (l) return (l[0].toUpperCase() + l.slice(1)).slice(0, 40);
    }
    const parts = domain.split('.').filter(Boolean);
    const label =
        (parts.length >= 2 ? parts[parts.length - 2] : parts[0]) ?? '';
    const clean = label.replace(/\//g, '').trim();
    if (!clean) return 'Expéditeur';
    return (clean[0].toUpperCase() + clean.slice(1)).slice(0, 40);
}

function uniqueName(base: string, taken: Set<string>): string {
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) {
        const suffix = ` ${i}`;
        name = base.slice(0, 40 - suffix.length) + suffix;
    }
    taken.add(name.toLowerCase());
    return name;
}

function mergeStats(
    target: { hits: number; lastHitAt?: number },
    rule: MailRule,
): void {
    target.hits += rule.hits;
    if (
        rule.lastHitAt !== undefined &&
        rule.lastHitAt > (target.lastHitAt ?? 0)
    ) {
        target.lastHitAt = rule.lastHitAt;
    }
}

export function migrateRulesToSenders(
    rules: MailRule[],
    now: number,
): { file: SendersFile; report: MigrationReport } {
    const keep: KeepSender[] = [];
    const spam: SpamSender[] = [];
    const unknown: MigrationReport['unknown'] = [];
    const taken = new Set<string>();
    let dropped = 0;

    const keepOf = (m: string) =>
        keep.find((k) => k.match.toLowerCase() === m.toLowerCase());
    const spamOf = (m: string) =>
        spam.find((s) => s.match.toLowerCase() === m.toLowerCase());

    const removeSpam = (m: string) => {
        const i = spam.findIndex(
            (x) => x.match.toLowerCase() === m.toLowerCase(),
        );
        if (i >= 0) spam.splice(i, 1);
    };

    const live: MailRule[] = [];
    for (const r of rules) {
        if (!r.confirmed) {
            if (r.origin === 'signal' && r.when.from) {
                unknown.push({ match: r.when.from, proposed: 'spam' });
            }
            continue;
        }
        if (r.then.category === null || !r.when.from) {
            dropped++;
            continue;
        }
        live.push(r);
    }

    // Pass 1 : règles d'expéditeur seul ; pass 2 : règles {from, subject}
    // (qui peuvent précéder l'entrée de leur expéditeur dans le fichier).
    for (const r of live.filter((x) => !x.when.subject)) {
        const match = r.when.from as string;
        const cat = r.then.category as string;
        if (SPAM_CATEGORIES.has(cat)) {
            if (keepOf(match)) continue;
            const ex = spamOf(match);
            if (ex) mergeStats(ex, r);
            else {
                const s = newSpamSender(match, r.createdAt);
                s.hits = r.hits;
                if (r.lastHitAt !== undefined) s.lastHitAt = r.lastHitAt;
                spam.push(s);
            }
            continue;
        }
        const ex = keepOf(match);
        if (ex) {
            mergeStats(ex, r);
            continue;
        }
        removeSpam(match);
        const k = newKeepSender(
            {
                match,
                name: uniqueName(nameFromMatch(match), taken),
                read: READ_ALWAYS_CATEGORIES.has(cat) ? 'always' : 'never',
            },
            r.createdAt,
        );
        k.hits = r.hits;
        if (r.lastHitAt !== undefined) k.lastHitAt = r.lastHitAt;
        keep.push(k);
    }

    for (const r of live.filter((x) => x.when.subject)) {
        const match = r.when.from as string;
        const cat = r.then.category as string;
        let k = keepOf(match);
        if (!k && SPAM_CATEGORIES.has(cat)) {
            dropped++;
            continue;
        }
        if (!k) {
            removeSpam(match);
            k = newKeepSender(
                {
                    match,
                    name: uniqueName(nameFromMatch(match), taken),
                    read: 'never',
                },
                r.createdAt,
            );
            keep.push(k);
        }
        if (k.read !== 'rules') {
            k.readDefault = k.read === 'always';
            k.read = 'rules';
        }
        (k.rules ??= []).push({
            subject: r.when.subject as string,
            read: READ_ALWAYS_CATEGORIES.has(cat),
        });
        mergeStats(k, r);
    }

    return {
        file: { version: 3, keep, spam },
        report: {
            at: now,
            keep: keep.length,
            spam: spam.length,
            dropped,
            unknown,
            names: keep.map((k) => ({ match: k.match, name: k.name })),
        },
    };
}
