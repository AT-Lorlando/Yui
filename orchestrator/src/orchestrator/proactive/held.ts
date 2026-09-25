// File des événements « retenus » (verdict hold, cooldown de source, heures
// de silence) — la matière du prochain point. Bornée et purgée : ce qui n'a
// pas été dit en 48 h ne mérite plus de l'être.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import { eventKey, isExpired } from './events';
import type { Event } from './events';

export const HELD_MAX = 200;
export const HELD_MAX_AGE_MS = 48 * 3600_000;

export class HeldQueue {
    private items: Event[] = [];
    private max: number;
    private maxAgeMs: number;

    constructor(
        private file?: string,
        opts: { max?: number; maxAgeMs?: number } = {},
    ) {
        this.max = opts.max ?? HELD_MAX;
        this.maxAgeMs = opts.maxAgeMs ?? HELD_MAX_AGE_MS;
        this.load();
    }

    static defaultFile(): string {
        return dataPath('held-events.json');
    }

    private load(): void {
        if (!this.file) return;
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
                if (Array.isArray(raw)) this.items = raw;
            }
        } catch {
            /* fichier corrompu — on repart vide */
        }
    }

    private save(): void {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.items));
        } catch {
            /* best-effort */
        }
    }

    private purge(now: number): void {
        this.items = this.items.filter(
            (e) => !isExpired(e, now) && now - e.at <= this.maxAgeMs,
        );
    }

    add(e: Event, now: number): void {
        this.purge(now);
        const k = eventKey(e);
        const idx = this.items.findIndex((x) => eventKey(x) === k);
        if (idx !== -1) {
            this.items[idx] = e; // Remplace en place
        } else {
            this.items.push(e); // Ajoute nouveau
        }
        if (this.items.length > this.max)
            this.items = this.items.slice(-this.max);
        this.save();
    }

    peek(now: number): Event[] {
        this.purge(now);
        return [...this.items];
    }

    take(now: number): Event[] {
        const out = this.peek(now);
        this.items = [];
        this.save();
        return out;
    }

    size(): number {
        return this.items.length;
    }
}
