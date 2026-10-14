// Courrier v3 — le facteur : range chaque mail selon les listes d'expéditeurs
// (à garder → Boîtes/<Nom>, osef → Yui/Spam, inconnu → boîte de réception),
// fait lire par l'IA les mails « à lire » (ordres de lecture compris), et
// met à la corbeille les osef de plus de 15 jours. Jamais de suppression
// définitive ; seul le balayage appelle trash_email.
import { BadRequestError, NotFoundError } from './errors';
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';
import { cleanBody } from './bodyClean';
import { MailJournal, MailDecision, MAIL_JOURNAL_MAX } from './journal';
import { MailOrder, OrderStore } from './orders';
import {
    buildReaderSystem,
    buildReaderUser,
    parseReaderReply,
    ReaderItem,
    ReaderMail,
} from './reader';
import {
    matchesFrom,
    resolveSender,
    senderAddress,
    SenderStore,
    SenderVerdict,
    SPAM_LABEL,
    labelFor,
} from './senders';
import { detectSignal } from './signals';
import { CourierMail, parseMetaList } from './meta';

export { CourierMail, parseMetaList };

type MailRef = { mailId: string; from: string; subject: string; box?: string };

export interface CourierDeps {
    deviceHandler: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>;
    complete: (system: string, user: string) => Promise<string>;
    senders: SenderStore;
    orders: OrderStore;
    journal: MailJournal;
    readerPrompt: () => string;
    onNotify: (m: MailRef, item: ReaderItem) => void;
    onFacts?: (m: MailRef, item: ReaderItem) => void;
    /** Le lecteur a satisfait un ordre actif (`orderId` + `fulfilled`). */
    onFulfilled?: (m: MailRef, item: ReaderItem, order: MailOrder) => void;
    now?: () => number;
}

export interface UnknownSender {
    address: string;
    from: string;
    count: number;
    lastSubject: string;
    lastAt: number;
    lastMailId: string;
    signal?: string;
}

export interface CourierState {
    version: 3;
    processedIds: string[];
    readTries: Record<string, number>;
    unknown: Record<string, UnknownSender>;
    lastScanAt: number;
    lastSweepAt: number;
    stats: {
        keep: number;
        spam: number;
        inbox: number;
        read: number;
        notified: number;
        trashed: number;
    };
    /**
     * Mails « à lire » pas encore conclus (lot reporté ou lecture en échec).
     * Un gardé est archivé AVANT lecture : sans cette file, il sortirait de
     * `in:inbox` et ne serait jamais relu. `kind` = verdict au moment du
     * rangement : un inconnu devenu gardé entre-temps doit encore être rangé.
     */
    pending?: Record<string, PendingMail>;
}

export interface PendingMail {
    mail: CourierMail;
    kind: 'keep' | 'inbox';
}

export const LLM_BATCH = 12;
export const LLM_PER_POLL = 24;
export const TRASH_AFTER_DAYS = 15;
export const SWEEP_EVERY_MS = 24 * 3600_000;
export const READ_MAX_TRIES = 3;

const PROCESSED_MAX = 1000;
const UNKNOWN_MAX = 200;
const UNKNOWN_SHOWN = 100;
const PENDING_MAX = 200;
const DAY_MS = 86_400_000;
// -in:inbox : un mail remis en boîte de réception à la main n'est plus un osef
const SWEEP_QUERY = `label:"${SPAM_LABEL}" older_than:${TRASH_AFTER_DAYS}d -in:inbox`;

/**
 * `orchestrator.callTool` rend le texte « Error: … » au lieu de lever quand
 * le MCP signale `isError` ; le moteur lève déjà (callToolWithStatus), ceci
 * est la défense en profondeur.
 */
const TOOL_ERROR = /^(Error|Erreur)\b/i;

function chunks<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function loadPending(raw: unknown): Record<string, PendingMail> {
    const out: Record<string, PendingMail> = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
        const p = v as Partial<PendingMail> | null;
        if (
            p?.mail &&
            typeof p.mail.id === 'string' &&
            (p.kind === 'keep' || p.kind === 'inbox')
        ) {
            out[id] = { mail: p.mail, kind: p.kind };
        }
    }
    return out;
}

function emptyState(): CourierState {
    return {
        version: 3,
        processedIds: [],
        readTries: {},
        unknown: {},
        lastScanAt: 0,
        lastSweepAt: 0,
        stats: { keep: 0, spam: 0, inbox: 0, read: 0, notified: 0, trashed: 0 },
        pending: {},
    };
}

type Conclusion = Pick<
    MailDecision,
    'stage' | 'box' | 'read' | 'notify' | 'urgency' | 'reason' | 'orderId'
>;

interface ScanResult {
    /** Liste Gmail en échec : rien n'a été fait. */
    error?: string;
    scanned: number;
    kept: number;
    spammed: number;
    inbox: number;
    read: number;
    notified: number;
}

export class MailCourier {
    private file: string;
    private state: CourierState = emptyState();
    private processed = new Set<string>();
    private inflightScan: Promise<ScanResult> | null = null;
    private inflightSweep: Promise<number> | null = null;

    constructor(private deps: CourierDeps, stateFile?: string) {
        this.file = stateFile ?? dataPath('mail-courier.json');
        this.load();
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    getState(): CourierState {
        return this.state;
    }

    /** Appel d'outil ; un résultat texte « Error: … » / « Erreur … » lève. */
    private async call(
        tool: string,
        args: Record<string, unknown>,
    ): Promise<unknown> {
        const r = await this.deps.deviceHandler(tool, args);
        if (typeof r === 'string' && TOOL_ERROR.test(r.trimStart())) {
            throw new Error(r.trim());
        }
        return r;
    }

    /**
     * Un seul scan à la fois : le poll du connecteur et POST /mail/scan
     * partagent l'exécution en cours (sinon deux scans rangeraient et
     * feraient lire les mêmes mails).
     */
    scan(query = 'in:inbox newer_than:2d', max = 40): Promise<ScanResult> {
        if (this.inflightScan) return this.inflightScan;
        const p = this.doScan(query, max).finally(() => {
            this.inflightScan = null;
        });
        this.inflightScan = p;
        return p;
    }

    private async doScan(query: string, max: number): Promise<ScanResult> {
        const now = this.now();
        const { senders } = this.deps;
        const deviceHandler = (tool: string, args: Record<string, unknown>) =>
            this.call(tool, args);
        const res: ScanResult = {
            scanned: 0,
            kept: 0,
            spammed: 0,
            inbox: 0,
            read: 0,
            notified: 0,
        };
        const tally = (c: Conclusion) => {
            if (c.stage === 'keep') res.kept++;
            else if (c.stage === 'spam') res.spammed++;
            else if (c.stage === 'inbox') res.inbox++;
            if (c.read) res.read++;
            if (c.notify) res.notified++;
        };

        let listed: CourierMail[];
        try {
            listed = parseMetaList(
                await deviceHandler('list_messages_meta', {
                    query,
                    maxResults: max,
                }),
            );
        } catch (e) {
            // Gmail indisponible (jeton expiré…) : rien n'est rangé ni lu
            Logger.warn(`courrier : liste Gmail en échec : ${e}`);
            res.error = String((e as Error)?.message ?? e);
            return res;
        }
        res.scanned = listed.length;
        const pending = this.state.pending ?? (this.state.pending = {});
        const byId = new Map<string, CourierMail>();
        for (const m of [
            ...Object.values(pending).map((p) => p.mail),
            ...listed,
        ]) {
            if (!byId.has(m.id)) byId.set(m.id, m);
        }
        const fresh = [...byId.values()].filter(
            (m) => !this.processed.has(m.id),
        );

        const toRead: Array<{ mail: CourierMail; verdict: SenderVerdict }> = [];
        for (const m of fresh) {
            // déjà rangé / compté au poll précédent : seule la lecture reste à faire
            const before = pending[m.id]?.kind;
            const v = resolveSender(senders.file(), m);
            try {
                if (v.kind === 'keep') {
                    if (before !== 'keep') {
                        await deviceHandler('modify_labels', {
                            messageId: m.id,
                            add: [v.label],
                            archive: true,
                        });
                        senders.recordHit(v.sender.id, now);
                    }
                    if (v.read) toRead.push({ mail: m, verdict: v });
                    else
                        tally(
                            this.conclude(m, {
                                stage: 'keep',
                                box: v.sender.name,
                                read: false,
                            }),
                        );
                } else if (v.kind === 'spam') {
                    await deviceHandler('modify_labels', {
                        messageId: m.id,
                        add: [SPAM_LABEL],
                        archive: true,
                    });
                    senders.recordHit(v.sender.id, now);
                    tally(this.conclude(m, { stage: 'spam', read: false }));
                } else {
                    if (!before) this.rememberUnknown(m, now);
                    toRead.push({ mail: m, verdict: v });
                }
            } catch (e) {
                // rangement en échec : non traité, retenté au prochain poll
                Logger.warn(`courrier : rangement de ${m.id} en échec : ${e}`);
            }
        }

        // lecteur : LLM_PER_POLL max, le reste revient au poll suivant (non processed)
        for (const { mail, verdict } of toRead) {
            pending[mail.id] = {
                mail,
                kind: verdict.kind === 'keep' ? 'keep' : 'inbox',
            };
        }
        for (const batch of chunks(toRead.slice(0, LLM_PER_POLL), LLM_BATCH)) {
            for (const c of await this.readBatch(batch, now)) tally(c);
        }
        this.trimPending();
        this.state.lastScanAt = now;
        this.save();
        return res;
    }

    private async readBatch(
        batch: Array<{ mail: CourierMail; verdict: SenderVerdict }>,
        now: number,
    ): Promise<Conclusion[]> {
        const { orders } = this.deps;
        const boxOf = (v: SenderVerdict) =>
            v.kind === 'keep' ? v.sender.name : undefined;
        const readerMails: ReaderMail[] = [];
        for (const { mail, verdict } of batch) {
            let body = mail.snippet;
            try {
                // corps vide après nettoyage → l'extrait Gmail
                body =
                    cleanBody(
                        String(
                            await this.call('get_email', {
                                messageId: mail.id,
                            }),
                        ),
                    ) || mail.snippet;
            } catch (e) {
                Logger.warn(`courrier : corps de ${mail.id} illisible : ${e}`);
            }
            const rm: ReaderMail = {
                id: mail.id,
                from: mail.from,
                subject: mail.subject,
                body,
            };
            if (mail.date) rm.date = mail.date;
            const box = boxOf(verdict);
            if (box) rm.box = box;
            readerMails.push(rm);
        }
        const active = orders.active(now);
        let items: Array<ReaderItem | null>;
        try {
            const reply = await this.deps.complete(
                buildReaderSystem(this.deps.readerPrompt(), active),
                buildReaderUser(readerMails),
            );
            items = parseReaderReply(
                reply,
                batch.length,
                new Set(active.map((o) => o.id)),
            );
        } catch (e) {
            Logger.warn(`courrier : lecteur IA en échec : ${e}`);
            items = new Array(batch.length).fill(null);
        }

        const out: Conclusion[] = [];
        batch.forEach(({ mail, verdict }, i) => {
            const item = items[i];
            const box = boxOf(verdict);
            const stage = verdict.kind === 'keep' ? 'keep' : 'inbox';
            if (!item) {
                const tries = (this.state.readTries[mail.id] ?? 0) + 1;
                this.state.readTries[mail.id] = tries;
                if (tries >= READ_MAX_TRIES) {
                    out.push(this.conclude(mail, { stage, box, read: false }));
                }
                return;
            }
            const c: Conclusion = {
                stage,
                box,
                read: true,
                notify: item.notify,
                urgency: item.urgency,
                reason: item.reason || undefined,
                orderId: item.orderId,
            };
            out.push(this.conclude(mail, c));
            const fulfilled =
                item.orderId && item.fulfilled
                    ? orders.fulfill(item.orderId, mail.id, item.reason, now)
                    : null;
            const ref: MailRef = {
                mailId: mail.id,
                from: mail.from,
                subject: mail.subject,
            };
            if (box) ref.box = box;
            try {
                if (fulfilled) this.deps.onFulfilled?.(ref, item, fulfilled);
                if (item.notify) this.deps.onNotify(ref, item);
                else if (item.facts.length) this.deps.onFacts?.(ref, item);
            } catch (e) {
                Logger.warn(`courrier : relais de ${mail.id} en échec : ${e}`);
            }
        });
        return out;
    }

    /** Journal + processedIds (≤ 1000, FIFO) + stats + sauvegarde. */
    private conclude(m: CourierMail, c: Conclusion): Conclusion {
        const d: MailDecision = {
            at: this.now(),
            mailId: m.id,
            from: m.from,
            subject: m.subject,
            category:
                c.stage === 'keep'
                    ? `Boîtes/${c.box ?? ''}`
                    : c.stage === 'spam'
                    ? SPAM_LABEL
                    : 'inbox',
            stage: c.stage,
            applied: c.stage !== 'inbox',
        };
        for (const k of [
            'box',
            'read',
            'notify',
            'urgency',
            'reason',
            'orderId',
        ] as const) {
            if (c[k] !== undefined)
                (d as unknown as Record<string, unknown>)[k] = c[k];
        }
        this.deps.journal.add(d);
        this.markProcessed(m.id);
        delete this.state.readTries[m.id];
        if (this.state.pending) delete this.state.pending[m.id];
        const s = this.state.stats;
        if (c.stage === 'keep') s.keep++;
        else if (c.stage === 'spam') s.spam++;
        else if (c.stage === 'inbox') s.inbox++;
        if (c.read) s.read++;
        if (c.notify) s.notified++;
        this.save();
        return c;
    }

    private markProcessed(id: string): void {
        this.processed.add(id);
        this.state.processedIds.push(id);
        while (this.state.processedIds.length > PROCESSED_MAX) {
            this.processed.delete(this.state.processedIds.shift()!);
        }
    }

    private trimPending(): void {
        const p = this.state.pending ?? {};
        const ids = Object.keys(p);
        const dropped = ids.slice(0, Math.max(0, ids.length - PENDING_MAX));
        for (const id of dropped) {
            delete p[id];
            delete this.state.readTries[id];
        }
        if (dropped.length) {
            Logger.warn(
                `courrier : file de lecture pleine, ${dropped.length} mail(s) abandonné(s) sans lecture`,
            );
        }
    }

    private rememberUnknown(m: CourierMail, now: number): void {
        const address = senderAddress(m.from);
        if (!address) return;
        const prev = this.state.unknown[address];
        const u: UnknownSender = {
            address,
            from: m.from,
            count: (prev?.count ?? 0) + 1,
            lastSubject: m.subject,
            lastAt: now,
            lastMailId: m.id,
        };
        const signal = detectSignal(m)?.signal ?? prev?.signal;
        if (signal) u.signal = signal;
        this.state.unknown[address] = u;
        const all = Object.values(this.state.unknown);
        if (all.length > UNKNOWN_MAX) {
            all.sort((a, b) => a.lastAt - b.lastAt);
            for (const x of all.slice(0, all.length - UNKNOWN_MAX)) {
                delete this.state.unknown[x.address];
            }
        }
    }

    unknown(): UnknownSender[] {
        return Object.values(this.state.unknown)
            .sort((a, b) => b.lastAt - a.lastAt)
            .slice(0, UNKNOWN_SHOWN);
    }

    /**
     * Inconnus proposés par la migration v2 (signaux non confirmés) : posés
     * dans la file « à trier » pour que l'app les montre pré-cochés osef.
     * Un inconnu déjà connu de la file n'est pas écrasé.
     */
    seedUnknown(entries: Array<{ match: string }>): number {
        const now = this.now();
        let added = 0;
        for (const { match } of entries) {
            const key = match.trim().toLowerCase();
            if (!key || this.state.unknown[key]) continue;
            this.state.unknown[key] = {
                address: key,
                from: match,
                count: 0,
                lastSubject: '',
                lastAt: now,
                lastMailId: '',
                signal: 'quarantaine',
            };
            added++;
        }
        if (added) this.save();
        return added;
    }

    forgetUnknown(address: string): void {
        const key = address.trim().toLowerCase();
        if (!this.state.unknown[key]) return;
        delete this.state.unknown[key];
        this.save();
    }

    /**
     * Corbeille des Yui/Spam de plus de 15 jours, au plus une fois par
     * SWEEP_EVERY_MS. Le label seul ne suffit pas : un mail n'est jeté que
     * si les listes le disent ENCORE osef (expéditeur passé « à garder » ou
     * retiré entre-temps → label Yui/Spam retiré, plus jamais candidat).
     */
    sweep(): Promise<number> {
        if (this.inflightSweep) return this.inflightSweep;
        const p = this.doSweep().finally(() => {
            this.inflightSweep = null;
        });
        this.inflightSweep = p;
        return p;
    }

    private async doSweep(): Promise<number> {
        const now = this.now();
        if (now - this.state.lastSweepAt < SWEEP_EVERY_MS) return 0;
        let mails: CourierMail[];
        try {
            mails = parseMetaList(
                await this.call('list_messages_meta', {
                    query: SWEEP_QUERY,
                    maxResults: 50,
                }),
            );
        } catch (e) {
            Logger.warn(`courrier : balayage osef impossible : ${e}`);
            return 0;
        }
        this.state.lastSweepAt = now;
        let trashed = 0;
        for (const m of mails) {
            if (resolveSender(this.deps.senders.file(), m).kind !== 'spam') {
                Logger.debug(
                    `courrier : ${m.id} n'est plus osef, ${SPAM_LABEL} retiré sans corbeille`,
                );
                try {
                    await this.call('modify_labels', {
                        messageId: m.id,
                        remove: [SPAM_LABEL],
                    });
                } catch (e) {
                    Logger.warn(
                        `courrier : retrait de ${SPAM_LABEL} sur ${m.id} en échec : ${e}`,
                    );
                }
                continue;
            }
            try {
                await this.call('trash_email', {
                    messageId: m.id,
                });
            } catch (e) {
                Logger.warn(`courrier : corbeille de ${m.id} en échec : ${e}`);
                continue;
            }
            trashed++;
            this.state.stats.trashed++;
            this.deps.journal.add({
                at: now,
                mailId: m.id,
                from: m.from,
                subject: m.subject,
                category: SPAM_LABEL,
                stage: 'trash',
                applied: true,
                read: false,
            });
        }
        this.save();
        return trashed;
    }

    /**
     * Rangement rétroactif d'un « à garder » (≤ max mails sur 90 jours) ;
     * JAMAIS de corbeille. Refusé pour un osef : étiqueter Yui/Spam des mois
     * de courrier d'un coup les livrerait au balayage.
     */
    async applySender(
        id: string,
        max = 100,
    ): Promise<{ matched: number; applied: number }> {
        const senders = this.deps.senders;
        const keep = senders.keep().find((s) => s.id === id);
        if (!keep) {
            if (senders.spam().some((s) => s.id === id)) {
                throw new BadRequestError(
                    "le rangement rétroactif n'existe que pour les expéditeurs à garder",
                );
            }
            throw new NotFoundError(`Expéditeur introuvable : ${id}`);
        }
        const match = keep.match;
        const label = labelFor(keep);
        const mails = parseMetaList(
            await this.call('list_messages_meta', {
                query: `from:${match} newer_than:90d`,
                maxResults: max,
            }),
        ).filter((m) => matchesFrom(match, m.from));
        let applied = 0;
        for (const m of mails) {
            try {
                // « à garder » l'emporte sur osef : retirer Yui/Spam, sinon le
                // balayage mettrait ces mails à la corbeille 15 jours plus tard
                await this.call('modify_labels', {
                    messageId: m.id,
                    add: [label],
                    remove: [SPAM_LABEL],
                    archive: true,
                });
                applied++;
            } catch (e) {
                Logger.warn(`courrier : rangement de ${m.id} en échec : ${e}`);
            }
        }
        return { matched: mails.length, applied };
    }

    /** Verdict des listes sur une requête, sans aucune écriture. */
    async dryRun(
        query = 'newer_than:30d',
        max = 100,
    ): Promise<
        Array<{
            mailId: string;
            from: string;
            subject: string;
            verdict: SenderVerdict;
        }>
    > {
        const file = this.deps.senders.file();
        return parseMetaList(
            await this.call('list_messages_meta', {
                query,
                maxResults: max,
            }),
        ).map((m) => ({
            mailId: m.id,
            from: m.from,
            subject: m.subject,
            verdict: resolveSender(file, m),
        }));
    }

    /** Décisions des `days` derniers jours (dans la limite de l'anneau du journal). */
    stats(days = 7): {
        total: number;
        byStage: Record<string, number>;
        read: number;
        notified: number;
        trashed: number;
    } {
        const since = this.now() - days * DAY_MS;
        const out = {
            total: 0,
            byStage: {} as Record<string, number>,
            read: 0,
            notified: 0,
            trashed: 0,
        };
        for (const d of this.deps.journal.list(MAIL_JOURNAL_MAX)) {
            if (d.at < since) continue;
            out.total++;
            out.byStage[d.stage] = (out.byStage[d.stage] ?? 0) + 1;
            if (d.read) out.read++;
            if (d.notify) out.notified++;
            if (d.stage === 'trash') out.trashed++;
        }
        return out;
    }

    private load(): void {
        if (!fs.existsSync(this.file)) return;
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
            if (!raw || typeof raw !== 'object' || raw.version !== 3) {
                throw new Error('version 3 attendue');
            }
            const base = emptyState();
            this.state = {
                ...base,
                ...raw,
                processedIds: Array.isArray(raw.processedIds)
                    ? raw.processedIds.filter(
                          (x: unknown) => typeof x === 'string',
                      )
                    : [],
                readTries:
                    raw.readTries && typeof raw.readTries === 'object'
                        ? raw.readTries
                        : {},
                unknown:
                    raw.unknown && typeof raw.unknown === 'object'
                        ? raw.unknown
                        : {},
                pending: loadPending(raw.pending),
                stats: { ...base.stats, ...(raw.stats ?? {}) },
            };
        } catch (e) {
            Logger.warn(`mail-courier.json illisible, réinitialisation : ${e}`);
            this.state = emptyState();
        }
        this.processed = new Set(this.state.processedIds);
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
        } catch (e) {
            Logger.warn(`mail-courier.json non écrit : ${e}`);
        }
    }
}
