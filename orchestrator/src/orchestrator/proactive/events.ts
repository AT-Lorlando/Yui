// Schéma d'événement unique du bus (spec §4). Tout ce qui entre dans la
// proactivité — polls des connecteurs, `subscribe`, `POST /events` — est
// d'abord normalisé ici. Pur, testé.
import * as crypto from 'crypto';
import type { CandidateEvent, Importance } from './types';

export type EventKind = 'alert' | 'info' | 'request' | 'digest';

export interface Event {
    /** Id du connecteur ou nom de l'app émettrice. */
    source: string;
    /** Idempotence : `source:key` identifie l'événement. */
    key: string;
    kind: EventKind;
    importance: Importance;
    /** ≤ 200 caractères, une ligne — lue telle quelle par le TTS. */
    subject: string;
    /** ≤ 10 lignes, factuel, jamais inventé. */
    facts: string[];
    /** Epoch ms côté source (défaut : réception). */
    at: number;
    /** Périmé après `at + ttlMs`. */
    ttlMs?: number;
    /** Action whitelistée proposée (mécanisme existant). */
    action?: { id: string; tag: string };
    /** URL profonde (Koya, Astronix…). */
    link?: string;
    /** Fenêtre anti-répétition propre (défaut : config). Interne, non exposé à /events. */
    cooldownMs?: number;
    /** Message pré-écrit → court-circuite le LLM (pipeline legacy). Interne. */
    template?: string;
}

export interface Fact {
    label: string;
    value: string;
    importance?: Importance;
}

export const SUBJECT_MAX = 200;
export const FACTS_MAX_LINES = 10;
export const FACT_MAX_CHARS = 300;
export const BATCH_MAX = 50;
const KINDS: EventKind[] = ['alert', 'info', 'request', 'digest'];
const IMPORTANCES: Importance[] = ['info', 'utile', 'urgent', 'critique'];

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function parseEvent(raw: unknown, opts: { now?: number } = {}): Event {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('événement : objet attendu');
    }
    const r = raw as Record<string, unknown>;
    const source = str(r.source).slice(0, 40);
    if (!source) throw new Error('source requise');
    const key = str(r.key).slice(0, 120);
    if (!key) throw new Error('key requise');
    const kind = str(r.kind) as EventKind;
    if (!KINDS.includes(kind))
        throw new Error(`kind invalide (${KINDS.join('|')})`);
    const importance = str(r.importance) as Importance;
    if (!IMPORTANCES.includes(importance)) {
        throw new Error(`importance invalide (${IMPORTANCES.join('|')})`);
    }
    const subject = str(r.subject).replace(/\s+/g, ' ');
    if (!subject) throw new Error('subject requis');
    if (subject.length > SUBJECT_MAX)
        throw new Error(`subject trop long (max ${SUBJECT_MAX})`);
    const factsRaw = r.facts === undefined ? [] : r.facts;
    if (!Array.isArray(factsRaw))
        throw new Error('facts : liste de chaînes attendue');
    const facts = factsRaw
        .map((f) => str(f).slice(0, FACT_MAX_CHARS))
        .filter(Boolean);
    if (facts.length > FACTS_MAX_LINES)
        throw new Error(`facts : ${FACTS_MAX_LINES} lignes maximum`);
    const now = opts.now ?? Date.now();
    const at =
        typeof r.at === 'number' && Number.isFinite(r.at) && r.at > 0
            ? r.at
            : now;
    const e: Event = { source, key, kind, importance, subject, facts, at };
    if (r.ttlMs !== undefined) {
        if (
            typeof r.ttlMs !== 'number' ||
            !Number.isFinite(r.ttlMs) ||
            r.ttlMs < 0
        ) {
            throw new Error('ttlMs : nombre >= 0 attendu');
        }
        e.ttlMs = r.ttlMs;
    }
    if (r.link !== undefined) {
        const link = str(r.link);
        if (!/^https?:\/\/\S+$/.test(link))
            throw new Error('link : URL http(s) attendue');
        e.link = link.slice(0, 500);
    }
    if (r.action !== undefined) {
        const a = r.action as Record<string, unknown> | null;
        const id = str(a?.id);
        const tag = str(a?.tag);
        if (!id || !tag) throw new Error('action : { id, tag } attendu');
        e.action = { id, tag };
    }
    if (typeof r.cooldownMs === 'number' && r.cooldownMs >= 0)
        e.cooldownMs = r.cooldownMs;
    if (str(r.template)) e.template = str(r.template);
    return e;
}

/** Tableau (ou objet seul) — tout ou rien : une erreur et rien n'est accepté. */
export function parseEvents(
    raw: unknown,
    opts: { now?: number } = {},
): { events: Event[]; errors: { index: number; message: string }[] } {
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length > BATCH_MAX) {
        return {
            events: [],
            errors: [
                {
                    index: -1,
                    message: `${BATCH_MAX} événements maximum par appel`,
                },
            ],
        };
    }
    const events: Event[] = [];
    const errors: { index: number; message: string }[] = [];
    list.forEach((item, index) => {
        try {
            events.push(parseEvent(item, opts));
        } catch (err) {
            errors.push({
                index,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });
    return errors.length ? { events: [], errors } : { events, errors };
}

export function isExpired(e: Event, now: number): boolean {
    return e.ttlMs !== undefined && e.at + e.ttlMs < now;
}

export const eventKey = (e: Event): string => `${e.source}:${e.key}`;

/** Empreinte des facts (espaces normalisés) — une réémission différente passe la dédup. */
export function factsFingerprint(e: Event): string {
    const norm = e.facts.map((f) => f.replace(/\s+/g, ' ').trim()).join('\n');
    return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/** Adaptateur pour les `evaluateXxx` existants (qui produisent des CandidateEvent). */
export function fromCandidate(c: CandidateEvent, now: number): Event {
    const kind: EventKind = c.proposedAction
        ? 'request'
        : c.importance === 'urgent' || c.importance === 'critique'
        ? 'alert'
        : 'info';
    const subject =
        c.facts.replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX) || c.subject;
    return {
        source: c.watcherId,
        key: c.subject,
        kind,
        importance: c.importance,
        subject,
        facts: [c.facts],
        at: now,
        ...(c.cooldownMs !== undefined ? { cooldownMs: c.cooldownMs } : {}),
        ...(c.proposedAction ? { action: c.proposedAction } : {}),
        ...(c.template ? { template: c.template } : {}),
    };
}
