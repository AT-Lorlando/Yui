// Journal des décisions de tri — trace ce qui a été classé et pourquoi
// (audit, page /mail, diagnostic du facteur). Anneau borné : ce n'est pas
// un historique complet, seulement de quoi comprendre les dernières minutes.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';

/** Étages v2 (rule/signal/llm/fallback, anciennes entrées) et v3 (keep/spam/inbox/trash). */
export type DecisionStage =
    | 'rule'
    | 'signal'
    | 'llm'
    | 'fallback'
    | 'keep'
    | 'spam'
    | 'inbox'
    | 'trash';
export type DecisionUrgency = 'none' | 'soon' | 'now';

export interface MailDecision {
    at: number;
    mailId: string;
    from: string;
    subject: string;
    category: string;
    stage: DecisionStage;
    ruleId?: string;
    signal?: string;
    urgency?: DecisionUrgency;
    reason?: string;
    applied: boolean;
    /** v3 : nom de la boîte (expéditeur gardé). */
    box?: string;
    /** v3 : le mail est passé au lecteur IA. */
    read?: boolean;
    /** v3 : le lecteur a demandé de prévenir. */
    notify?: boolean;
    /** v3 : ordre de lecture auquel le mail répond. */
    orderId?: string;
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
        // copies : un appelant qui mute le résultat ne doit pas corrompre l'anneau interne
        return this.decisions.slice(0, limit).map((d) => ({ ...d }));
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
            // fichier corrompu : on repart à vide plutôt que de planter le courrier au démarrage
            Logger.warn(`mail-journal.json illisible, réinitialisation : ${e}`);
            this.decisions = [];
        }
    }

    private save(): void {
        // best-effort : une écriture qui échoue (disque plein, droits, parent = fichier…) ne doit
        // jamais faire planter le tri qu'elle journalise — l'entrée reste au moins en mémoire
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(
                this.file,
                JSON.stringify(
                    { version: 1, decisions: this.decisions },
                    null,
                    2,
                ),
            );
        } catch (e) {
            Logger.warn(`mail-journal.json non écrit : ${e}`);
        }
    }
}
