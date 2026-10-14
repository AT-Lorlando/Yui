import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';
import { BadRequestError } from './errors';

export type ReadMode = 'always' | 'never' | 'rules';

export interface ContentRule {
    /** Expression régulière (insensible à la casse) testée sur le sujet. */
    subject: string;
    read: boolean;
}

export interface KeepSender {
    id: string;
    match: string;
    name: string;
    read: ReadMode;
    rules?: ContentRule[];
    readDefault?: boolean;
    hits: number;
    lastHitAt?: number;
    createdAt: number;
}

export interface SpamSender {
    id: string;
    match: string;
    hits: number;
    lastHitAt?: number;
    createdAt: number;
}

export interface SendersFile {
    version: 3;
    keep: KeepSender[];
    spam: SpamSender[];
}

export type SenderVerdict =
    | { kind: 'keep'; sender: KeepSender; read: boolean; label: string }
    | { kind: 'spam'; sender: SpamSender }
    | { kind: 'inbox' };

export const SPAM_LABEL = 'Yui/Spam';
export const BOXES_PARENT = 'Boîtes';

/** Adresse de l'expéditeur ("Nom <a@b.c>" → "a@b.c") ; le nom affiché ne compte jamais. */
export function senderAddress(from: string): string {
    const m = /<([^>]+)>/.exec(from);
    return (m?.[1] ?? from).trim().toLowerCase();
}

/** Domaine de l'expéditeur ("Zalando <news@mail.zalando.fr>" → "mail.zalando.fr"). */
export function senderDomain(from: string): string {
    const m = /@([\w.-]+)/.exec(from);
    return (m?.[1] ?? from).toLowerCase();
}

/** Sous-chaîne insensible à la casse sur l'adresse parsée ou le from brut. */
export function matchesFrom(match: string, from: string): boolean {
    const needle = match.toLowerCase();
    if (!needle) return false;
    return (
        senderAddress(from).includes(needle) ||
        from.toLowerCase().includes(needle)
    );
}

export function labelFor(s: KeepSender): string {
    return `${BOXES_PARENT}/${s.name}`;
}

// Une regex invalide ne doit jamais casser le tri : règle ignorée, un warn par id.
const warnedInvalid = new Set<string>();

export function readFor(s: KeepSender, subject: string): boolean {
    if (s.read === 'always') return true;
    if (s.read === 'never') return false;
    for (const rule of s.rules ?? []) {
        try {
            if (new RegExp(rule.subject, 'i').test(subject)) return rule.read;
        } catch (e) {
            if (!warnedInvalid.has(s.id)) {
                warnedInvalid.add(s.id);
                Logger.warn(
                    `mail sender ${s.id}: expression régulière invalide "${
                        rule.subject
                    }" (${(e as Error).message})`,
                );
            }
        }
    }
    return s.readDefault ?? false;
}

export function resolveSender(
    file: SendersFile,
    mail: { from: string; subject: string },
): SenderVerdict {
    let best: KeepSender | undefined;
    for (const k of file.keep) {
        if (!matchesFrom(k.match, mail.from)) continue;
        if (!best || k.match.length > best.match.length) best = k;
    }
    if (best) {
        return {
            kind: 'keep',
            sender: best,
            read: readFor(best, mail.subject),
            label: labelFor(best),
        };
    }
    const spam = file.spam.find((s) => matchesFrom(s.match, mail.from));
    if (spam) return { kind: 'spam', sender: spam };
    return { kind: 'inbox' };
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Domaines grand public : une règle de domaine nu y attraperait tout le monde. */
export const PUBLIC_DOMAINS = new Set([
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

/**
 * Raison du refus d'un `match` (ou null s'il est sûr) : trop court, sans `.`
 * ni `@` (« bot » attraperait n'importe quel expéditeur), ou domaine grand
 * public nu (`gmail.com`, `@gmail.com`).
 */
export function unsafeMatchReason(match: string): string | null {
    const m = match.trim().toLowerCase();
    if (m.length < 2) {
        return "l'expéditeur (match) doit faire au moins 2 caractères";
    }
    if (!m.includes('.') && !m.includes('@')) {
        return "l'expéditeur (match) doit contenir un « . » ou un « @ »";
    }
    if (PUBLIC_DOMAINS.has(m.replace(/^@/, ''))) {
        return "précise l'adresse pour un domaine grand public";
    }
    return null;
}

/** Lève une BadRequestError (→ 400) si le match n'est pas sûr. */
export function assertSafeMatch(match: string, where?: string): void {
    const reason = unsafeMatchReason(match);
    if (reason) {
        throw new BadRequestError(where ? `${where} : ${reason}` : reason);
    }
}

function checkMatch(v: unknown, where: string): string {
    if (typeof v !== 'string') {
        throw new BadRequestError(
            `${where} : l'expéditeur (match) doit faire au moins 2 caractères`,
        );
    }
    assertSafeMatch(v, where);
    return v;
}

function checkCommon(
    o: Record<string, unknown>,
    where: string,
    ids: Set<string>,
): void {
    if (typeof o.id !== 'string' || !o.id) {
        throw new Error(`${where} : id manquant`);
    }
    if (ids.has(o.id)) throw new Error(`${where} : id en double "${o.id}"`);
    ids.add(o.id);
    checkMatch(o.match, where);
    if (typeof o.hits !== 'number') throw new Error(`${where} : hits invalide`);
    if (typeof o.createdAt !== 'number') {
        throw new Error(`${where} : createdAt invalide`);
    }
}

export const RULES_MAX = 20;

/** Champs propres à un « à garder » (nom, read, readDefault, rules) ; lève une Error française. */
export function validateKeepFields(
    k: Record<string, unknown>,
    where: string,
): void {
    if (k.match !== undefined) checkMatch(k.match, where);
    if (
        typeof k.name !== 'string' ||
        k.name.length < 1 ||
        k.name.length > 40 ||
        k.name.includes('/')
    ) {
        throw new Error(
            `${where} : le nom doit faire 1 à 40 caractères, sans "/"`,
        );
    }
    if (k.read !== 'always' && k.read !== 'never' && k.read !== 'rules') {
        throw new Error(`${where} : read doit valoir always, never ou rules`);
    }
    if (k.readDefault !== undefined && typeof k.readDefault !== 'boolean') {
        throw new Error(`${where} : readDefault doit être un booléen`);
    }
    if (k.rules !== undefined) {
        if (Array.isArray(k.rules) && k.rules.length > RULES_MAX) {
            throw new Error(`${where} : au plus ${RULES_MAX} règles`);
        }
        if (!Array.isArray(k.rules)) {
            throw new Error(`${where} : rules doit être un tableau`);
        }
        k.rules.forEach((r: unknown, j: number) => {
            const rw = `${where}.rules[${j}]`;
            if (
                !isObj(r) ||
                typeof r.subject !== 'string' ||
                typeof r.read !== 'boolean'
            ) {
                throw new Error(`${rw} : {subject, read} attendu`);
            }
            try {
                new RegExp(r.subject, 'i');
            } catch (e) {
                throw new Error(
                    `${rw} : expression régulière invalide "${r.subject}" (${
                        (e as Error).message
                    })`,
                );
            }
        });
    }
}

/** Valide un fichier brut (tout-ou-rien) ; lève une Error au message français. */
export function validateSendersFile(raw: unknown): SendersFile {
    if (!isObj(raw)) throw new Error('Le fichier doit être un objet JSON');
    if (raw.version !== 3) throw new Error('Version attendue : 3');
    if (!Array.isArray(raw.keep))
        throw new Error('"keep" doit être un tableau');
    if (!Array.isArray(raw.spam))
        throw new Error('"spam" doit être un tableau');
    const ids = new Set<string>();

    raw.keep.forEach((k: unknown, i: number) => {
        const where = `keep[${i}]`;
        if (!isObj(k)) throw new Error(`${where} : objet attendu`);
        checkCommon(k, where, ids);
        validateKeepFields(k, where);
    });
    raw.spam.forEach((s: unknown, i: number) => {
        const where = `spam[${i}]`;
        if (!isObj(s)) throw new Error(`${where} : objet attendu`);
        checkCommon(s, where, ids);
    });
    return raw as unknown as SendersFile;
}

/**
 * Au chargement seulement : une entrée écrite avant la règle de sûreté des
 * `match` est écartée (warn) plutôt que de faire rejeter — et vider — tout
 * le fichier.
 */
function dropUnsafeMatches(raw: unknown): unknown {
    if (!isObj(raw)) return raw;
    const out: Record<string, unknown> = { ...raw };
    for (const key of ['keep', 'spam']) {
        const list = raw[key];
        if (!Array.isArray(list)) continue;
        out[key] = list.filter((e: unknown) => {
            const m = isObj(e) && typeof e.match === 'string' ? e.match : null;
            const reason = m === null ? null : unsafeMatchReason(m);
            if (reason) {
                Logger.warn(
                    `mail-senders.json : "${m}" écarté au chargement (${reason})`,
                );
                return false;
            }
            return true;
        });
    }
    return out;
}

function newId(prefix: string): string {
    return prefix + crypto.randomBytes(3).toString('hex');
}

export function newKeepSender(
    input: {
        match: string;
        name: string;
        read?: ReadMode;
        rules?: ContentRule[];
        readDefault?: boolean;
    },
    now: number,
): KeepSender {
    const s: KeepSender = {
        id: newId('k-'),
        match: input.match,
        name: input.name,
        read: input.read ?? 'never',
        hits: 0,
        createdAt: now,
    };
    if (input.rules) s.rules = input.rules;
    if (input.readDefault !== undefined) s.readDefault = input.readDefault;
    return s;
}

export function newSpamSender(match: string, now: number): SpamSender {
    return { id: newId('s-'), match, hits: 0, createdAt: now };
}

export class SenderStore {
    private path: string;
    private data: SendersFile = { version: 3, keep: [], spam: [] };

    constructor(file?: string) {
        this.path = file ?? dataPath('mail-senders.json');
        this.load();
    }

    exists(): boolean {
        return fs.existsSync(this.path);
    }

    file(): SendersFile {
        return this.data;
    }

    keep(): KeepSender[] {
        return this.data.keep;
    }

    spam(): SpamSender[] {
        return this.data.spam;
    }

    upsertKeep(s: KeepSender): void {
        const i = this.data.keep.findIndex((x) => x.id === s.id);
        if (i >= 0) this.data.keep[i] = s;
        else this.data.keep.push(s);
        this.save();
    }

    upsertSpam(s: SpamSender): void {
        const i = this.data.spam.findIndex((x) => x.id === s.id);
        if (i >= 0) this.data.spam[i] = s;
        else this.data.spam.push(s);
        this.save();
    }

    remove(id: string): boolean {
        for (const list of [this.data.keep, this.data.spam] as {
            id: string;
        }[][]) {
            const i = list.findIndex((x) => x.id === id);
            if (i >= 0) {
                list.splice(i, 1);
                this.save();
                return true;
            }
        }
        return false;
    }

    /** Remplace tout le fichier, tout-ou-rien : lève (sans rien modifier) si invalide. */
    replace(raw: unknown): SendersFile {
        this.data = validateSendersFile(raw);
        this.save();
        return this.data;
    }

    recordHit(id: string, now: number): void {
        const s = [...this.data.keep, ...this.data.spam].find(
            (x) => x.id === id,
        );
        if (!s) return;
        s.hits += 1;
        s.lastHitAt = now;
        this.save();
    }

    private load(): void {
        if (!fs.existsSync(this.path)) return;
        try {
            this.data = validateSendersFile(
                dropUnsafeMatches(
                    JSON.parse(fs.readFileSync(this.path, 'utf-8')),
                ),
            );
        } catch (e) {
            Logger.warn(`mail-senders.json illisible, réinitialisation : ${e}`);
            this.data = { version: 3, keep: [], spam: [] };
        }
    }

    save(): void {
        try {
            fs.mkdirSync(path.dirname(this.path), { recursive: true });
            fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
        } catch (e) {
            Logger.warn(`mail-senders.json non écrit : ${e}`);
        }
    }
}
