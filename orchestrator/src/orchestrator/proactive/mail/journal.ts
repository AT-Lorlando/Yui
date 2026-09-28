// Journal des décisions de tri — trace ce qui a été classé et pourquoi
// (audit, page /mail, diagnostic du concierge). Anneau borné : ce n'est pas
// un historique complet, seulement de quoi comprendre les dernières minutes.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';
import type { Stage, Urgency } from './triage';

export interface MailDecision {
    at: number;
    mailId: string;
    from: string;
    subject: string;
    category: string;
    stage: Stage;
    ruleId?: string;
    signal?: string;
    urgency?: Urgency;
    reason?: string;
    applied: boolean;
}

export const MAIL_JOURNAL_MAX = 200;

export class MailJournal {
    private file: string;
    private decisions: MailDecision[] = [];

    constructor(file?: string) {
        this.file = file ?? MailJournal.defaultFile();
        this.load();
    }

    static defaultFile(): string {
        return dataPath('mail-journal.json');
    }

    /** Ajoute en tête (plus récent d'abord) ; l'anneau écrête la queue au-delà de MAIL_JOURNAL_MAX. */
    add(d: MailDecision): void {
        this.decisions.unshift(d);
        if (this.decisions.length > MAIL_JOURNAL_MAX) {
            this.decisions.length = MAIL_JOURNAL_MAX;
        }
        this.save();
    }

    list(limit: number = 50): MailDecision[] {
        return this.decisions.slice(0, limit);
    }

    size(): number {
        return this.decisions.length;
    }

    private load(): void {
        if (!fs.existsSync(this.file)) {
            this.decisions = [];
            return;
        }
        try {
            const raw = fs.readFileSync(this.file, 'utf-8');
            const parsed = JSON.parse(raw) as { decisions?: MailDecision[] };
            this.decisions = Array.isArray(parsed?.decisions)
                ? parsed.decisions
                : [];
        } catch (e) {
            // fichier corrompu : on repart à vide plutôt que de planter le concierge au démarrage
            Logger.warn(`mail-journal.json illisible, réinitialisation : ${e}`);
            this.decisions = [];
        }
    }

    private save(): void {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(
            this.file,
            JSON.stringify({ version: 1, decisions: this.decisions }, null, 2),
        );
    }
}
