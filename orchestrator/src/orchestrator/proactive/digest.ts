import * as fs from 'fs';
import * as path from 'path';
import type { CandidateEvent } from './types';
import { hmToMinutes } from './gates';
import { dataPath } from '@yui/shared';

const DIGEST_FILE = dataPath('proactive-digest.json');

export class DigestBuffer {
    private events: CandidateEvent[] = [];
    private _lastFlush = 0;

    constructor(private file: string = DIGEST_FILE) {
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
                this.events = Array.isArray(raw.events) ? raw.events : [];
                this._lastFlush = raw.lastFlush ?? 0;
            }
        } catch {
            /* fichier corrompu — on repart vide */
        }
    }

    private save(): void {
        try {
            fs.writeFileSync(
                this.file,
                JSON.stringify(
                    { events: this.events, lastFlush: this._lastFlush },
                    null,
                    2,
                ),
            );
        } catch {
            /* best-effort */
        }
    }

    add(ev: CandidateEvent): void {
        if (this.events.some((e) => e.subject === ev.subject)) return;
        this.events.push(ev);
        this.save();
    }

    /** Retire un sujet du buffer (ex. il vient d'être notifié en direct, pour
     *  éviter que le digest le répète). No-op s'il n'y est pas. */
    remove(subject: string): boolean {
        const before = this.events.length;
        this.events = this.events.filter((e) => e.subject !== subject);
        const removed = this.events.length !== before;
        if (removed) this.save();
        return removed;
    }

    size(): number {
        return this.events.length;
    }

    lastFlush(): number {
        return this._lastFlush;
    }

    takeAll(now: number): CandidateEvent[] {
        const out = this.events;
        this.events = [];
        this._lastFlush = now;
        this.save();
        return out;
    }
}

export function isDigestDue(
    now: Date,
    digestTime: string,
    lastFlush: number,
): boolean {
    const due = hmToMinutes(digestTime);
    const t = now.getHours() * 60 + now.getMinutes();
    if (t < due) return false;
    const last = new Date(lastFlush);
    const sameDay =
        last.getFullYear() === now.getFullYear() &&
        last.getMonth() === now.getMonth() &&
        last.getDate() === now.getDate();
    const lastMinutes = last.getHours() * 60 + last.getMinutes();
    return !(sameDay && lastMinutes >= due);
}
