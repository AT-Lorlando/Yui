// Journal des interventions proactives — chaque décision du juge (émise OU
// retenue) est tracée, et l'app permet un 👍/👎 par intervention. C'est la
// boucle de feedback : les retours sont réinjectés dans le prompt du juge
// (« il a toujours ignoré les alertes trafic ») et c'est aussi le compteur
// du budget d'interruptions quotidien.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';

export type JournalChannel = 'speak' | 'notify' | 'hold' | 'skip';
export type Feedback = 'up' | 'down';

export interface JournalEntry {
    id: string;
    at: number;
    /** Brique/watcher d'origine (weather, moment-wake, deliveries…). */
    source: string;
    subject: string;
    channel: JournalChannel;
    /** Message émis (speak/notify) ou résumé de ce qui a été retenu. */
    message: string;
    /** Justification du juge — visible dans l'app, utile pour comprendre. */
    reason?: string;
    feedback?: Feedback;
}

const MAX_ENTRIES = 300;

export class ProactiveJournal {
    private entries: JournalEntry[] = [];
    private file: string;

    constructor(file: string = dataPath('proactive-journal.json')) {
        this.file = file;
        try {
            if (fs.existsSync(file)) {
                const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
                if (Array.isArray(raw)) this.entries = raw;
                // Compat : le canal « digest » (digest quotidien, supprimé) devient « hold ».
                for (const e of this.entries) {
                    if ((e.channel as string) === 'digest') e.channel = 'hold';
                }
            }
        } catch (err) {
            Logger.warn(`proactive: journal illisible — ${err}`);
        }
    }

    private persist(): void {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(
                this.file,
                JSON.stringify(this.entries.slice(-MAX_ENTRIES)),
            );
        } catch (err) {
            Logger.warn(`proactive: journal non persisté — ${err}`);
        }
    }

    record(e: Omit<JournalEntry, 'id'>): JournalEntry {
        const entry: JournalEntry = {
            ...e,
            id: `${e.at.toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 6)}`,
        };
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) {
            this.entries = this.entries.slice(-MAX_ENTRIES);
        }
        this.persist();
        return entry;
    }

    setFeedback(id: string, feedback: Feedback): boolean {
        const e = this.entries.find((x) => x.id === id);
        if (!e) return false;
        e.feedback = feedback;
        this.persist();
        return true;
    }

    list(limit = 50): JournalEntry[] {
        return this.entries.slice(-limit).reverse();
    }

    /** Interruptions déjà émises aujourd'hui (speak = 1, notify = 0.5). */
    spentToday(now: number): number {
        const day = new Date(now).toDateString();
        let spent = 0;
        for (const e of this.entries) {
            if (new Date(e.at).toDateString() !== day) continue;
            if (e.channel === 'speak') spent += 1;
            else if (e.channel === 'notify') spent += 0.5;
        }
        return spent;
    }

    /**
     * Condensé des retours pour le prompt du juge : les derniers 👍/👎 avec
     * leur sujet — le juge apprend ce qui lasse et ce qui sert.
     */
    feedbackSummary(limit = 12): string {
        const rated = this.entries.filter((e) => e.feedback).slice(-limit);
        if (!rated.length) return '';
        return rated
            .map(
                (e) =>
                    `${e.feedback === 'up' ? '👍' : '👎'} [${e.source}] ${
                        e.subject
                    } — « ${e.message.slice(0, 80)} »`,
            )
            .join('\n');
    }

    /** Dernières interventions (tous canaux) — contexte anti-répétition du juge. */
    recentSummary(now: number, limit = 8): string {
        const dayMs = 24 * 3600 * 1000;
        return this.entries
            .filter((e) => now - e.at < dayMs && e.channel !== 'skip')
            .slice(-limit)
            .map(
                (e) =>
                    `- il y a ${Math.round((now - e.at) / 60000)} min [${
                        e.channel
                    }] ${e.subject}: « ${e.message.slice(0, 100)} »`,
            )
            .join('\n');
    }
}
