// Attentes — « j'attends un truc, ping-moi ». Une attente porte des mots-clés
// (tous requis) et, optionnellement, une source ; le premier événement du bus
// qui la satisfait est poussé tout de suite, quelles que soient les heures de
// silence ou le quota de sa source (cf. `Ingest`). Persistance
// `data/state/watches.json` ; satisfaites/expirées gardées 24 h puis purgées.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import type { Event } from './events';

export type WatchState = 'active' | 'fulfilled' | 'expired';

export interface Watch {
    /** `w-xxxxxx` */
    id: string;
    text: string;
    source?: string;
    keywords: string[];
    createdAt: number;
    expiresAt: number;
    state: WatchState;
    fulfilledAt?: number;
    matchedKey?: string;
    matchedSubject?: string;
    origin: 'voice' | 'app';
    mailOrderId?: string;
}

export interface WatchInput {
    text: string;
    source?: string;
    keywords: string[];
    days?: number;
    origin: 'voice' | 'app';
    mailOrderId?: string;
}

export const WATCH_TEXT_MIN = 5;
export const WATCH_TEXT_MAX = 300;
export const WATCH_KEYWORDS_MAX = 5;
export const WATCH_KEYWORD_MAX_CHARS = 40;
export const WATCH_DAYS_DEFAULT = 7;
export const WATCH_DAYS_MAX = 60;
export const WATCHES_MAX = 40;
export const WATCH_KEEP_DONE_MS = 24 * 3600_000;

const DAY_MS = 86_400_000;

/** Minuscules, accents retirés, espaces compactés. Pur. */
export function normalizeText(s: string): string {
    return s
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/** Pur : source égale si l'attente en porte une ; TOUS les mots-clés
 *  (normalisés) présents dans clé + sujet + faits normalisés. */
export function matchWatch(w: Watch, e: Event): boolean {
    if (w.source && w.source !== e.source) return false;
    const keywords = w.keywords.map(normalizeText).filter(Boolean);
    if (!keywords.length) return false;
    const hay = normalizeText([e.key, e.subject, ...(e.facts ?? [])].join(' '));
    return keywords.every((k) => hay.includes(k));
}

function looksLikeWatch(w: unknown): w is Watch {
    const o = w as Partial<Watch> | null | undefined;
    return (
        typeof o?.id === 'string' &&
        typeof o?.text === 'string' &&
        Array.isArray(o?.keywords) &&
        typeof o?.expiresAt === 'number' &&
        typeof o?.state === 'string'
    );
}

export class WatchStore {
    private data: Watch[] = [];

    constructor(private file: string = dataPath('watches.json')) {
        this.load();
    }

    all(): Watch[] {
        return [...this.data];
    }

    active(now: number): Watch[] {
        return this.data.filter(
            (w) => w.state === 'active' && w.expiresAt > now,
        );
    }

    find(id: string): Watch | undefined {
        return this.data.find((w) => w.id === id);
    }

    byMailOrder(orderId: string): Watch | undefined {
        return this.data.find((w) => w.mailOrderId === orderId);
    }

    /** Valide puis ajoute ; une entrée invalide lève une `Error` au message
     *  lisible (renvoyé tel quel en 400 par la route). */
    add(input: WatchInput, now: number): Watch {
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (text.length < WATCH_TEXT_MIN || text.length > WATCH_TEXT_MAX) {
            throw new Error(
                `Le texte de l'attente doit faire ${WATCH_TEXT_MIN} à ${WATCH_TEXT_MAX} caractères`,
            );
        }
        if (
            !Array.isArray(input.keywords) ||
            input.keywords.length < 1 ||
            input.keywords.length > WATCH_KEYWORDS_MAX
        ) {
            throw new Error(
                `Il faut 1 à ${WATCH_KEYWORDS_MAX} mots-clés pour une attente`,
            );
        }
        const keywords = input.keywords.map((k) =>
            typeof k === 'string' ? k.trim().replace(/\s+/g, ' ') : '',
        );
        if (keywords.some((k) => !k || k.length > WATCH_KEYWORD_MAX_CHARS)) {
            throw new Error(
                `Chaque mot-clé doit être non vide et faire au plus ${WATCH_KEYWORD_MAX_CHARS} caractères`,
            );
        }
        const days = input.days ?? WATCH_DAYS_DEFAULT;
        if (
            typeof days !== 'number' ||
            !Number.isFinite(days) ||
            days < 1 ||
            days > WATCH_DAYS_MAX
        ) {
            throw new Error(
                `La durée d'une attente doit être de 1 à ${WATCH_DAYS_MAX} jours`,
            );
        }
        const source =
            typeof input.source === 'string' ? input.source.trim() : '';
        this.expire(now);
        if (this.active(now).length >= WATCHES_MAX) {
            throw new Error(`Trop d'attentes actives (maximum ${WATCHES_MAX})`);
        }
        const w: Watch = {
            id: 'w-' + crypto.randomBytes(3).toString('hex'),
            text,
            keywords,
            createdAt: now,
            expiresAt: now + days * DAY_MS,
            state: 'active',
            origin: input.origin === 'voice' ? 'voice' : 'app',
        };
        if (source) w.source = source;
        if (input.mailOrderId) w.mailOrderId = input.mailOrderId;
        this.data.push(w);
        this.save();
        return w;
    }

    fulfill(
        id: string,
        matched: { key: string; subject: string },
        now: number,
    ): Watch | undefined {
        const w = this.find(id);
        if (!w) return undefined;
        w.state = 'fulfilled';
        w.fulfilledAt = now;
        w.matchedKey = matched.key;
        w.matchedSubject = matched.subject;
        this.save();
        return w;
    }

    remove(id: string): boolean {
        const i = this.data.findIndex((w) => w.id === id);
        if (i < 0) return false;
        this.data.splice(i, 1);
        this.save();
        return true;
    }

    /** Actives échues → `expired` ; satisfaites/expirées depuis plus de
     *  24 h → purgées. Sauve seulement si quelque chose a changé. */
    expire(now: number): void {
        let changed = false;
        for (const w of this.data) {
            if (w.state === 'active' && w.expiresAt <= now) {
                w.state = 'expired';
                changed = true;
            }
        }
        const kept = this.data.filter((w) => {
            if (w.state === 'active') return true;
            const doneAt =
                w.state === 'fulfilled'
                    ? w.fulfilledAt ?? w.expiresAt
                    : w.expiresAt;
            return now - doneAt <= WATCH_KEEP_DONE_MS;
        });
        if (kept.length !== this.data.length) {
            this.data = kept;
            changed = true;
        }
        if (changed) this.save();
    }

    private load(): void {
        try {
            if (!fs.existsSync(this.file)) return;
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
            const list = Array.isArray(raw?.watches) ? raw.watches : [];
            this.data = list.filter(looksLikeWatch);
        } catch (e) {
            Logger.warn(`watches.json illisible, réinitialisation : ${e}`);
            this.data = [];
        }
    }

    save(): void {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(
                this.file,
                JSON.stringify({ version: 1, watches: this.data }, null, 2),
            );
        } catch (e) {
            Logger.warn(`watches.json non écrit : ${e}`);
        }
    }
}
