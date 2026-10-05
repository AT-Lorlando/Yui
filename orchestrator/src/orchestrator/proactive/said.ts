// Mémoire longue de ce que Yui a DÉJÀ dit (spec §3). Le Dedup court reste
// l'anti-rafale des urgents ; ici on répond à « est-ce que je lui ai déjà
// annoncé ça ? » avec une validité qui dépend de la nature du fait — une
// vacance annoncée ne l'est plus jamais, un colis l'est une fois par statut.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';

export type SaidNature =
    | 'alert'
    | 'request'
    | 'info'
    | 'digest'
    | 'agenda-far'
    | 'agenda-today'
    | 'postit-stale';

export interface SaidEntry {
    at: number;
    channel: 'speak' | 'notify' | 'brief';
    fingerprint: string;
    /** Fin de validité (epoch ms) ; null = définitif. */
    until: number | null;
    /** Absents des anciens fichiers : lecture tolérante. */
    nature?: SaidNature;
    downvoted?: boolean;
}

export const DAY_MS = 24 * 3600_000;
const DOWNVOTE_MS = 30 * DAY_MS;

function nextMidnight(at: number): number {
    const d = new Date(at);
    d.setHours(24, 0, 0, 0);
    return d.getTime();
}

export function saidDurationMs(nature: SaidNature, at: number): number | null {
    switch (nature) {
        case 'agenda-far':
            return null;
        case 'agenda-today':
            return nextMidnight(at) - at;
        case 'request':
        case 'digest':
        case 'postit-stale':
            return 7 * DAY_MS;
        case 'alert':
        case 'info':
            return DAY_MS;
    }
}

export class SaidMemory {
    private entries = new Map<string, SaidEntry>();

    constructor(private file?: string) {
        this.load();
    }

    static defaultFile(): string {
        return dataPath('said.json');
    }

    private load(): void {
        if (!this.file) return;
        try {
            if (!fs.existsSync(this.file)) return;
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                for (const [k, v] of Object.entries(
                    raw as Record<string, SaidEntry>,
                )) {
                    if (
                        v &&
                        typeof v.at === 'number' &&
                        typeof v.fingerprint === 'string'
                    )
                        this.entries.set(k, v);
                }
            }
        } catch {
            /* corrompu → vide */
        }
    }

    private save(): void {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(
                this.file,
                JSON.stringify(Object.fromEntries(this.entries)),
            );
        } catch {
            /* best-effort */
        }
    }

    isSaid(subject: string, fingerprint: string, now: number): boolean {
        const e = this.entries.get(subject);
        if (!e || e.fingerprint !== fingerprint) return false;
        return e.until === null || now < e.until;
    }

    markSaid(
        items: Array<{
            subject: string;
            fingerprint: string;
            nature: SaidNature;
        }>,
        channel: SaidEntry['channel'],
        now: number,
    ): void {
        for (const it of items) {
            const d = saidDurationMs(it.nature, now);
            this.entries.set(it.subject, {
                at: now,
                nature: it.nature,
                channel,
                fingerprint: it.fingerprint,
                until: d === null ? null : now + d,
            });
        }
        this.save();
    }

    /** true si le sujet existait. */
    close(subject: string): boolean {
        const had = this.entries.delete(subject);
        if (had) this.save();
        return had;
    }

    /** Lecture pour l'app (le fingerprint reste interne), plus récent d'abord. */
    list(): Array<{
        subject: string;
        nature: SaidNature | null;
        at: number;
        until: number | null;
        downvoted: boolean;
    }> {
        return [...this.entries.entries()]
            .map(([subject, e]) => ({
                subject,
                nature: e.nature ?? null,
                at: e.at,
                until: e.until,
                downvoted: e.downvoted === true,
            }))
            .sort((a, b) => b.at - a.at);
    }

    clear(): void {
        this.entries.clear();
        this.save();
    }

    downvote(subjects: string[], now: number): void {
        for (const s of subjects) {
            const e = this.entries.get(s);
            if (e)
                this.entries.set(s, {
                    ...e,
                    until: now + DOWNVOTE_MS,
                    downvoted: true,
                });
        }
        this.save();
    }

    purge(now: number): void {
        for (const [k, e] of this.entries)
            if (e.until !== null && now >= e.until) this.entries.delete(k);
        this.save();
    }

    size(): number {
        return this.entries.size;
    }
}
