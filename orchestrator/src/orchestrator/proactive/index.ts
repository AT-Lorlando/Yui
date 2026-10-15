import Logger from '../../logger';
import { dataPath } from '@yui/shared';
import { isQuietHours, passesThreshold } from './gates';
import { Dedup } from './dedup';
import { HeldQueue } from './held';
import { RateWindow } from './rate';
import { Ingest } from './ingest';
import type { IngestOutcome } from './ingest';
import { eventKey, factsFingerprint, fromCandidate } from './events';
import type { Event } from './events';
import { PostitRegistry, createPostitFor } from './postits';
import { isActionBlocked } from './guard';
import { loadHistory } from '../history';
import { loadAutomations } from '../automations';
import { loadConfig, DEFAULT_PHRASE_PROMPT } from './config';
import {
    ConnectorNotFound,
    ConnectorRunner,
    connectorMode,
    pushRecent,
} from './runner';
import type { ConnectorStatusView, RecentEvent } from './runner';
import { buildConnectors } from './connectors';
import type { ConnectorContext, ConnectorDef } from './connector';
import {
    isBrickEnabled,
    bricksView,
    brickSetting,
    registerConnectorBricks,
} from './bricks';
import { ProactiveJournal } from './journal';
import type { Feedback, JournalEntry } from './journal';
import { Judge } from './judge';
import type { JudgeInput, JudgeVerdict } from './judge';
import { SaidMemory } from './said';
import { BriefComposer } from './brief/composer';
import type { BriefResult } from './brief/composer';
import type { BriefFact, BriefInputs } from './brief/facts';
import { heldToFact, visibleFacts } from './brief/facts';
import {
    buildSituation,
    diffSituation,
    loadSituation,
    saveSituation,
} from './situation';
import type { Situation } from './situation';
import { detectMoments, returnMomentFacts } from './moments';
import { MailCourier } from './mail/courier';
import { SenderStore } from './mail/senders';
import { OrderStore } from './mail/orders';
import { loadReaderPrompt } from './mail/reader';
import type { ReaderItem } from './mail/reader';
import { MailJournal } from './mail/journal';
import { migrateMailRulesAtBoot } from './mail/bootMigration';
import { senderName } from './connectors/mail';
import type { FulfilledNotice, MailNotice } from './connectors/mail';
import type { MailOrder } from './mail/orders';
import { WatchStore, WATCH_DAYS_DEFAULT, matchWatch } from './watches';
import type { Watch } from './watches';
import { saveConfig } from './config';
import type { MomentKind, MomentState } from './moments';
import type { CandidateEvent, ProactiveConfig, ProactiveDeps } from './types';

const DEDUP_FILE = dataPath('proactive-dedup.json');
/** Cadence de reconstruction du journal de situation (lectures store, pas cher). */
const SITUATION_POLL_MS = 2 * 60_000;
const DEFAULT_BUDGET_PER_DAY = 3;
/** Post-its Yoji que les intentions `todo` peuvent créer par jour. */
const DEFAULT_POSTITS_PER_DAY = 5;
/** Plafond par source et par heure — barrière anti-flood sans LLM (spec §5.3.4). */
const DEFAULT_MAX_PER_HOUR = 6;
/** Sections historiques de proactive.json fusionnées dans les réglages du
 *  connecteur de même id (config d'avant les briques ; jamais étendu). */
const LEGACY_SECTIONS = new Set(['weather', 'calendar', 'mail', 'deliveries']);
/** Tuile « mails importants » du dashboard, sans réglage hérité. */
export const DASHBOARD_MAIL_QUERY = 'is:important is:unread newer_than:1d';
/** Files courrier moteur → connecteur : bornées si le connecteur ne poll
 *  plus (brique coupée) alors qu'un scan est lancé à la demande. */
const MAIL_QUEUE_MAX = 100;
/** Sorties immédiates du courrier par jour local — au-delà, rien n'est
 *  poussé (l'événement du connecteur porte le fait du plafond). */
export const MAIL_NOTIFY_PER_DAY = 5;

function pushBounded<T>(queue: T[], item: T): void {
    queue.push(item);
    if (queue.length > MAIL_QUEUE_MAX)
        queue.splice(0, queue.length - MAIL_QUEUE_MAX);
}

/** Au-delà, un événement ne se décide plus à la main (même horizon que la
 *  file des retenus). */
export const DECIDE_MAX_AGE_MS = 48 * 3600_000;

export type DecideChannel = 'speak' | 'notify' | 'skip';
export type DecideTarget = { held: string } | { journal: string };

export class DecisionNotFound extends Error {
    constructor(what: string) {
        super(`événement introuvable : ${what}`);
        this.name = 'DecisionNotFound';
    }
}
export class DecisionExpired extends Error {
    constructor(what: string) {
        super(`événement trop ancien pour être décidé : ${what}`);
        this.name = 'DecisionExpired';
    }
}

export class ProactiveEngine {
    private dedup: Dedup;
    private held: HeldQueue;
    private rate = new RateWindow();
    private ingestGate: Ingest;
    private runner: ConnectorRunner | null = null;
    private connectors: ConnectorDef[] = [];
    /** Sources externes (`POST /events`) vues depuis le démarrage — leur
     *  « statut » pour la page des connecteurs (mémoire de process). */
    private externalStatus = new Map<
        string,
        {
            lastEventAt: number;
            lastKey: string;
            lastSubject: string;
            lastOutcome: IngestOutcome;
            recent: RecentEvent[];
        }
    >();
    private now: () => number;
    private situationTimer?: ReturnType<typeof setInterval>;
    readonly journal: ProactiveJournal;
    readonly courier: MailCourier;
    readonly mailSenders: SenderStore;
    readonly mailOrders: OrderStore;
    readonly mailJournal: MailJournal;
    /** Attentes « j'attends un truc, ping-moi » (`watches.json`). */
    readonly watches: WatchStore;
    /** Mails signalés tout de suite (notifyMail), en attente de leur
     *  événement `request` (post-it, plafond d'urgences) au poll du connecteur. */
    private pendingMailNotify: MailNotice[] = [];
    /** Faits de mails lus sans alerte, en attente de leur événement `info`. */
    private pendingMailFacts: MailNotice[] = [];
    /** Ordres satisfaits par le lecteur, en attente de leur événement `info`. */
    private pendingMailFulfilled: FulfilledNotice[] = [];
    /** Plafond quotidien des sorties immédiates : jour local courant et
     *  sorties réservées. Réamorcé depuis le journal à chaque nouveau jour
     *  (donc aussi après un redémarrage) — le journal est la persistance. */
    private mailNotifyDay = '';
    private mailNotifyCount = 0;
    /** Mails plafonnés du jour ; seul le premier est écrit au journal. */
    private mailCappedCount = 0;
    private judge: Judge;
    private said: SaidMemory;
    private postits: PostitRegistry;
    private composer: BriefComposer;
    private situation: Situation | null;
    private momentState: MomentState = { firedDepartures: [] };
    private lastDeltas: string[] = [];
    /** Sérialise les moments : le tick d'intervalle et la transition de
     *  présence peuvent appeler `handleMoment` en même temps, or le dédup
     *  2 h et la sélection des faits doivent voir l'un après l'autre — sinon
     *  les deux passes retiennent les mêmes faits « dit » avant qu'aucune
     *  n'ait eu le temps de les marquer, et le point sort deux fois. */
    private momentChain: Promise<void> = Promise.resolve();
    /** Une seule fermeture : le cache de lecture d'agenda est indexé par
     *  identité de fonction, le journal de situation et les connecteurs
     *  doivent donc passer par la même. */
    private readonly callTool: ConnectorContext['callTool'] = (t, a) =>
        this.deps.deviceHandler(t, a);

    constructor(
        private cfg: ProactiveConfig,
        private deps: ProactiveDeps,
        opts: {
            dedup?: Dedup;
            journal?: ProactiveJournal;
            held?: HeldQueue;
            said?: SaidMemory;
            postits?: PostitRegistry;
            watches?: WatchStore;
        } = {},
    ) {
        this.now = deps.now ?? (() => Date.now());
        this.dedup = opts.dedup ?? new Dedup(DEDUP_FILE);
        this.journal = opts.journal ?? new ProactiveJournal();
        this.held = opts.held ?? new HeldQueue(HeldQueue.defaultFile());
        this.said = opts.said ?? new SaidMemory(SaidMemory.defaultFile());
        this.postits =
            opts.postits ?? new PostitRegistry(PostitRegistry.defaultFile());
        this.situation = loadSituation();
        this.watches = opts.watches ?? new WatchStore();
        this.ingestGate = new Ingest({
            dedup: this.dedup,
            held: this.held,
            rate: this.rate,
            now: this.now,
            defaultCooldownMs: () => this.cfg.defaultCooldownMin * 60_000,
            maxPerHour: (source) =>
                brickSetting(
                    this.cfg,
                    this.sourceBrick(source),
                    'maxPerHour',
                    DEFAULT_MAX_PER_HOUR,
                ),
            quietHours: () => this.cfg.quietHours,
            isSourceEnabled: (source) =>
                isBrickEnabled(this.cfg, this.sourceBrick(source)),
            onNewSource: (source) => this.declareExternal(source),
            judge: (e) => this.consume(e),
            watches: {
                match: (e) => {
                    const now = this.now();
                    this.watches.expire(now);
                    return this.watches
                        .active(now)
                        .find((w) => matchWatch(w, e));
                },
                onHit: (w, e) => this.watchHit(w, e),
            },
        });
        this.judge = new Judge({
            complete: (sys, user) => this.deps.complete(sys, user),
            journal: this.journal,
            budgetPerDay: () => this.cfg.budgetPerDay ?? DEFAULT_BUDGET_PER_DAY,
            now: this.now,
        });
        this.composer = new BriefComposer({
            complete: (sys, user) => this.deps.complete(sys, user),
            said: this.said,
            held: this.held,
            journal: this.journal,
            presence: () => this.deps.presenceState(),
            notify: (t) => this.deps.notify(t),
            speak: (t) => this.deps.speak(t),
            now: this.now,
            quiet: () => this.isQuiet(),
        });
        // Courrier v3 : listes d'expéditeurs (migrées une fois des règles v2),
        // ordres de lecture, facteur.
        this.mailSenders = new SenderStore();
        this.mailOrders = new OrderStore();
        this.mailJournal = new MailJournal();
        this.courier = new MailCourier({
            deviceHandler: (t, a) => this.mailToolCall(t, a),
            complete: (sys, user) => this.deps.complete(sys, user),
            senders: this.mailSenders,
            orders: this.mailOrders,
            journal: this.mailJournal,
            readerPrompt: () => loadReaderPrompt(),
            onNotify: (m, item) => void this.notifyMail(m, item),
            onFacts: (m, item) => {
                pushBounded(this.pendingMailFacts, { ...m, item });
            },
            onFulfilled: (m, item, order) =>
                this.mailOrderFulfilled(m, item, order),
            now: this.now,
        });
        // Après le facteur : les inconnus du rapport rejoignent sa file.
        migrateMailRulesAtBoot(this.mailSenders, this.now(), {
            seedUnknown: (entries) => this.courier.seedUnknown(entries),
        });
        this.connectors = buildConnectors({
            mail: {
                courier: this.courier,
                orders: this.mailOrders,
                takeNotified: () => this.takeMailNotified(),
                takeFacts: () => this.pendingMailFacts.splice(0),
                takeFulfilled: () => this.takeMailFulfilled(),
            },
            orders: this.mailOrders,
            complete: (sys, user) => this.deps.complete(sys, user),
            subscribePresence: (cb) => this.deps.subscribePresence(cb),
            legacy: {
                weather: this.cfg.weather,
                calendar: this.cfg.calendar,
                mail: this.cfg.mail,
                deliveries: this.cfg.deliveries,
            },
        });
        // État de module : les briques des connecteurs doivent être connues de
        // `getBricks()`/`isBrickEnabled` dès la construction, pas au `start()`.
        registerConnectorBricks(this.connectors);
    }

    /**
     * Appel d'outil du facteur : une erreur MCP (`isError`) LÈVE au lieu de
     * rendre le texte « Error: … » — sinon un modify_labels raté serait
     * journalisé appliqué et le mail marqué traité.
     */
    private async mailToolCall(
        tool: string,
        args?: Record<string, unknown>,
    ): Promise<unknown> {
        if (!this.deps.callToolWithStatus) {
            return this.deps.deviceHandler(tool, args);
        }
        const { result, isError } = await this.deps.callToolWithStatus(
            tool,
            args ?? {},
        );
        if (isError) throw new Error(String(result));
        return result;
    }

    /** La brique qui gouverne une source : le connecteur/moment lui-même s'il
     *  en a une, sinon la brique implicite `external:<source>`. Le rameau
     *  `moment-*` est mort en pratique aujourd'hui (les moments passent par
     *  `handleMoment`, pas par `ingest`) — il ne fait que garder une future
     *  ingestion directe d'une source moment de finir en `external:`. */
    private sourceBrick(source: string): string {
        return this.connectors.some((c) => c.id === source) ||
            source.startsWith('moment-')
            ? source
            : `external:${source}`;
    }

    /** Une app externe inconnue apparaît sur /proactive dès son premier
     *  événement — écrit une fois, jamais réécrite ensuite. `saveConfig`
     *  remplace tout `bricks` d'un coup, donc écrire à partir du seul
     *  `this.cfg` périmé écraserait un `PUT /proactive` arrivé sur le disque
     *  depuis le dernier `reload()` : on part de la config FRAÎCHE du disque
     *  pour les briques qui y existent (elle gagne sur `this.cfg` en cas de
     *  divergence), tout en gardant celles qui n'existent qu'en mémoire —
     *  un cfg construit directement (tests) n'a jamais touché le disque. */
    private declareExternal(source: string): void {
        const id = this.sourceBrick(source);
        if (!id.startsWith('external:') || this.cfg.bricks?.[id]) return;
        const fresh = loadConfig();
        const bricks = {
            ...(this.cfg.bricks ?? {}),
            ...(fresh.bricks ?? {}),
            [id]: fresh.bricks?.[id] ?? { enabled: true, settings: {} },
        };
        // Active pour ce process quoi qu'il arrive, même si l'écriture rate.
        this.cfg.bricks = bricks;
        if (fresh.bricks?.[id]) return; // déjà déclarée entre-temps (autre process)
        try {
            saveConfig({ bricks });
        } catch (err) {
            Logger.warn(`proactive: brique ${id} non persistée — ${err}`);
        }
    }

    /** Résumé du courrier pour le dashboard (tuile Briefing). Les champs
     *  historiques `pendingCount`/`doubtCount` restent remplis pour l'app
     *  (inconnus / aucun doute) jusqu'à sa refonte. */
    getTriageSummary(): {
        unknownCount: number;
        ordersCount: number;
        pendingCount: number;
        doubtCount: number;
        actions: Array<{ subject: string; from: string }>;
        classifiedToday: number;
    } {
        const now = this.now();
        const today = new Date(now).toDateString();
        const decisions = this.mailJournal.list(200);
        const unknownCount = this.courier.unknown().length;
        return {
            unknownCount,
            ordersCount: this.mailOrders.active(now).length,
            pendingCount: unknownCount,
            doubtCount: 0,
            actions: decisions
                .filter((d) => d.notify)
                .slice(0, 8)
                .map((d) => ({ subject: d.subject, from: d.from })),
            classifiedToday: decisions.filter(
                (d) =>
                    d.applied &&
                    d.stage !== 'trash' &&
                    new Date(d.at).toDateString() === today,
            ).length,
        };
    }

    /** Ordre de lecture satisfait : fait « Ordre satisfait » pour le prochain
     *  point, même sans alerte ni faits (spec §3.1). */
    mailOrderFulfilled(
        m: { mailId: string; from: string; subject: string; box?: string },
        item: ReaderItem,
        order: MailOrder,
    ): void {
        pushBounded(this.pendingMailFulfilled, {
            ...m,
            item,
            order: { id: order.id, text: order.text },
        });
    }

    /** Vide la file des ordres satisfaits (consommée par le connecteur `mail`). */
    takeMailFulfilled(): FulfilledNotice[] {
        return this.pendingMailFulfilled.splice(0);
    }

    /** Réserve une sortie immédiate du courrier sous le plafond du jour —
     *  synchrone : un lot du lecteur appelle notifyMail en rafale. */
    private reserveMailNotify(): boolean {
        const now = this.now();
        const day = new Date(now).toDateString();
        if (day !== this.mailNotifyDay) {
            this.mailNotifyDay = day;
            const today = this.journal
                .list(300)
                .filter(
                    (e) =>
                        e.source === 'mail-reader' &&
                        new Date(e.at).toDateString() === day,
                );
            this.mailNotifyCount = today.filter(
                (e) => e.channel === 'speak' || e.channel === 'notify',
            ).length;
            // Relu après un redémarrage : l'entrée « plafonnée » du jour
            // n'est écrite qu'une fois.
            this.mailCappedCount = today.filter(
                (e) => e.channel === 'hold',
            ).length;
        }
        if (this.mailNotifyCount >= MAIL_NOTIFY_PER_DAY) {
            this.mailCappedCount++;
            return false;
        }
        this.mailNotifyCount++;
        return true;
    }

    /** Vide la file des mails signalés (consommée par le connecteur `mail`). */
    takeMailNotified(): MailNotice[] {
        return this.pendingMailNotify.splice(0);
    }

    /**
     * Ordre de lecture à la voix (tool `mail_watch`) : `days` est déjà borné
     * par le tool. Une erreur du store (texte, plafond) remonte telle quelle.
     */
    async mailWatch(text: string, days: number): Promise<string> {
        const o = this.mailOrders.add(
            { text, days, source: 'voice' },
            this.now(),
        );
        const d = new Date(o.expiresAt);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `D'accord, je guette ça jusqu'au ${pad(d.getDate())}/${pad(
            d.getMonth() + 1,
        )}.`;
    }

    getBricks() {
        return bricksView(this.cfg);
    }

    getJournal(limit = 50, before?: number): JournalEntry[] {
        return this.journal.list(limit, before);
    }

    private recordExternal(e: Event, outcome: IngestOutcome): void {
        const at = this.now();
        const cur = this.externalStatus.get(e.source);
        const recent = cur?.recent ?? [];
        pushRecent(recent, { key: e.key, subject: e.subject, at, outcome });
        this.externalStatus.set(e.source, {
            lastEventAt: at,
            lastKey: e.key,
            lastSubject: e.subject,
            lastOutcome: outcome,
            recent,
        });
    }

    /** Page des connecteurs : les connecteurs actifs (statut du runner), les
     *  déclarés mais à l'arrêt (brique OFF ou moteur désactivé), puis les
     *  sources externes vues depuis le démarrage. */
    connectorsView(): ConnectorStatusView[] {
        const running = new Map(
            (this.runner?.status() ?? []).map((v) => [v.id, v]),
        );
        const out: ConnectorStatusView[] = this.connectors.map((def) => {
            const live = running.get(def.id);
            if (live) return live;
            const pollMinutes = this.connectorPollMinutes(def.id);
            const view: ConnectorStatusView = {
                id: def.id,
                name: def.name,
                description: def.description,
                enabled: false,
                failures: 0,
                recent: [],
                mode: connectorMode({ ...def, pollMinutes }),
                polling: false,
            };
            if (pollMinutes) view.pollMinutes = pollMinutes;
            return view;
        });
        const bricks = bricksView(this.cfg);
        for (const [src, st] of this.externalStatus) {
            const id = `external:${src}`;
            const brick = bricks.find((b) => b.id === id);
            out.push({
                id,
                name: brick?.name ?? src,
                description:
                    brick?.description ?? 'Source externe (POST /events).',
                enabled: brick?.enabled ?? isBrickEnabled(this.cfg, id),
                mode: 'subscribe',
                failures: 0,
                lastOkAt: st.lastEventAt,
                recent: [...st.recent],
                polling: false,
            });
        }
        return out;
    }

    /** Relève manuelle d'un connecteur actif — erreurs typées du runner
     *  (`ConnectorNotFound` aussi quand le moteur est arrêté). */
    async pollConnector(id: string) {
        if (!this.runner) throw new ConnectorNotFound(id);
        return this.runner.pollNow(id);
    }

    heldList(): Event[] {
        return this.held.peek(this.now());
    }

    /** `key` = `source:key` complet ; ne marque rien comme dit. */
    heldRemove(key: string): boolean {
        return this.held.remove([key]) > 0;
    }

    /**
     * Décision manuelle de Jérémy sur un retenu ou une entrée de journal :
     * texte déterministe (sans LLM), sortie, journal `manual` (réinjecté au
     * juge), dédup ; `speak`/`notify` marquent dit comme un point le ferait,
     * `skip` non (c'est l'ancien retrait simple).
     */
    async decide(
        target: DecideTarget,
        channel: DecideChannel,
    ): Promise<{ channel: DecideChannel; message: string }> {
        const now = this.now();
        const fromHeld = 'held' in target;
        const label = fromHeld ? target.held : target.journal;
        const event = fromHeld
            ? this.held.get(target.held)
            : this.journal.get(target.journal)?.event;
        if (!event) throw new DecisionNotFound(label);
        if (now - event.at > DECIDE_MAX_AGE_MS)
            throw new DecisionExpired(label);
        const key = eventKey(event);
        const first = visibleFacts(event)[0];
        const message =
            event.template ??
            (first ? `${event.subject}. ${first}` : event.subject);
        // Canal effectif : un `speak` demandé en l'absence de Jérémy n'est
        // qu'une notification (pushNow tranche).
        const effective: DecideChannel =
            channel === 'skip'
                ? 'skip'
                : await this.pushNow(message, channel === 'speak', true);
        this.journal.record({
            at: now,
            source: event.source,
            subject: event.key,
            channel: effective,
            message,
            reason: 'décision manuelle',
            kind: 'event',
            manual: true,
            event,
        });
        // Même depuis le journal : un retenu de même clé encore en file
        // ressortirait au prochain point alors que Jérémy vient de trancher.
        this.held.remove([key]);
        this.dedup.record(key, now, message, factsFingerprint(event));
        if (effective !== 'skip') {
            const f = heldToFact(event);
            this.said.markSaid(
                [
                    {
                        subject: f.subject,
                        fingerprint: f.fingerprint,
                        nature: f.nature,
                    },
                ],
                effective,
                now,
            );
        }
        return { channel: effective, message };
    }

    /** Attentes (actives + 24 h de satisfaites/expirées) et ordres courrier
     *  actifs posés par Jérémy (pas ceux des connecteurs, colis). */
    watchesView(now = this.now()): { watches: Watch[]; orders: MailOrder[] } {
        this.watches.expire(now);
        return {
            watches: this.watches.all(),
            orders: this.mailOrders
                .active(now)
                .filter((o) => o.source !== 'connector'),
        };
    }

    /**
     * Pose une attente. Sans source ou pour le courrier, crée aussi l'ordre
     * de lecture lié (`origin: watch:<id>`) : la correspondance sémantique du
     * lecteur reste le meilleur détecteur pour un mail. Une erreur de
     * validation (store d'attentes ou d'ordres) remonte telle quelle, sans
     * rien laisser derrière elle.
     */
    watchAdd(input: {
        what: string;
        source?: string;
        keywords: string[];
        days?: number;
        origin: 'voice' | 'app';
    }): Watch {
        const now = this.now();
        const source = input.source?.trim() || undefined;
        const w = this.watches.add(
            {
                text: input.what,
                ...(source ? { source } : {}),
                keywords: input.keywords,
                ...(input.days !== undefined ? { days: input.days } : {}),
                origin: input.origin,
            },
            now,
        );
        if (!source || source === 'mail') {
            try {
                const o = this.mailOrders.add(
                    {
                        text: w.text,
                        days: input.days ?? WATCH_DAYS_DEFAULT,
                        source: input.origin === 'voice' ? 'voice' : 'user',
                        origin: `watch:${w.id}`,
                    },
                    now,
                );
                w.mailOrderId = o.id;
                this.watches.save();
            } catch (err) {
                this.watches.remove(w.id);
                throw err;
            }
        }
        return w;
    }

    /** Retire une attente et son ordre courrier lié. */
    watchRemove(id: string): boolean {
        const w = this.watches.find(id);
        if (!w) return false;
        if (w.mailOrderId) this.mailOrders.remove(w.mailOrderId);
        return this.watches.remove(id);
    }

    /**
     * Attente satisfaite par un événement du bus : sortie immédiate,
     * déterministe (notification toujours, parole si présent et hors nuit —
     * ce n'est pas un critique), journal, dédup, ordre courrier lié retiré.
     */
    private async watchHit(w: Watch, e: Event): Promise<void> {
        const now = this.now();
        const key = eventKey(e);
        const text = `Ce que tu attendais : ${w.text}. ${e.subject}`;
        const channel = await this.pushNow(text, true);
        this.journal.record({
            at: now,
            source: e.source,
            subject: e.key,
            channel,
            message: text,
            reason: `attente : ${w.text}`,
            kind: 'event',
            event: e,
        });
        this.watches.fulfill(w.id, { key: e.key, subject: e.subject }, now);
        this.dedup.record(key, now, text, factsFingerprint(e));
        if (w.mailOrderId) this.mailOrders.remove(w.mailOrderId);
    }

    saidList() {
        return this.said.list();
    }

    saidForget(subject: string): boolean {
        return this.said.close(subject);
    }

    /** Nombre d'entrées oubliées. */
    saidForgetAll(): number {
        const n = this.said.size();
        this.said.clear();
        return n;
    }

    /** Un 👎 sur un point (moment/brief) fait taire ses sujets 30 jours dans
     *  la mémoire « dit » ; un 👍 n'apprend rien de plus que le journal. */
    setFeedback(id: string, feedback: Feedback): boolean {
        const ok = this.journal.setFeedback(id, feedback);
        if (!ok || feedback !== 'down') return ok;
        const subjects = this.journal.get(id)?.subjects;
        if (subjects?.length) this.said.downvote(subjects, this.now());
        return ok;
    }

    getSituation(): Situation | null {
        return this.situation;
    }

    /**
     * Un seul tick à la fois : il est déclenché par l'intervalle de 2 min ET
     * par la transition de présence, or un tick peut durer (snapshots des
     * connecteurs, juge). Deux passes concurrentes verraient le même `prev` et
     * détecteraient deux fois le même moment.
     */
    private tickBusy = false;

    /** Tick du journal de situation : reconstruit, diffe, détecte les moments. */
    async situationTick(): Promise<void> {
        if (this.tickBusy) return;
        this.tickBusy = true;
        try {
            const next = await buildSituation(
                {
                    callTool: this.callTool,
                    presenceState: () => this.deps.presenceState(),
                    now: this.now,
                },
                this.runner ? await this.runner.snapshots() : {},
            );
            const prev = this.situation;
            this.lastDeltas = diffSituation(prev, next);
            const { moments, state } = detectMoments(
                prev,
                next,
                this.momentState,
                (kind: MomentKind) => isBrickEnabled(this.cfg, kind),
            );
            this.momentState = state;
            this.situation = next;
            saveSituation(next);
            // Avant les moments : un sujet refermé ici peut ressortir dans
            // le point qui suit.
            await this.closeDonePostits();
            for (const m of moments) {
                await this.handleMoment(m.kind, m.facts);
            }
        } catch (err) {
            Logger.warn(`proactive: situation tick — ${err}`);
        } finally {
            this.tickBusy = false;
        }
    }

    /** Un post-it créé par Yui qui a disparu de Yoji est fait (ou jeté) :
     *  son origine sort de la mémoire « dit », ce qui la laisse ressortir si
     *  la source la réémet. Best-effort : Yoji injoignable ou réponse qui
     *  n'est pas une liste → rien n'est conclu (sinon une panne refermerait
     *  tout d'un coup). */
    private async closeDonePostits(): Promise<void> {
        const open = this.postits.open();
        if (!open.length) return;
        let raw: unknown;
        try {
            raw = await this.callTool('list_postits');
        } catch {
            return;
        }
        if (typeof raw === 'string') {
            try {
                raw = JSON.parse(raw);
            } catch {
                return;
            }
        }
        if (!Array.isArray(raw)) return;
        const alive = new Set(raw.map((p) => String(p?.id ?? '')));
        for (const { origin, postitId } of open) {
            if (alive.has(postitId)) continue;
            this.said.close(origin);
            this.postits.markClosed(origin);
            Logger.info(
                `proactive: post-it ${postitId} disparu de Yoji → sujet ${origin} refermé`,
            );
        }
    }

    /** Moment de vie détecté → le composeur fait le point (ou se tait, sans LLM).
     *  Chaînée sur `momentChain` : deux appels concurrents s'exécutent l'un
     *  après l'autre, jamais en parallèle. */
    handleMoment(kind: MomentKind, facts: string): Promise<void> {
        const run = this.momentChain.then(() =>
            this.handleMomentInner(kind, facts),
        );
        this.momentChain = run.catch(() => {});
        return run;
    }

    private async handleMomentInner(
        kind: MomentKind,
        facts: string,
    ): Promise<void> {
        const nowMs = this.now();
        // Un moment par fenêtre de 2 h max, quoi qu'il arrive — enregistré
        // avant de composer : un point qui échoue à l'émission ne doit pas
        // être retenté à chaque transition de présence.
        if (this.dedup.isDuplicate(kind, nowMs, 2 * 3600_000)) return;
        this.dedup.record(kind, nowMs);
        Logger.info(`proactive: moment "${kind}" — ${facts.slice(0, 120)}`);
        try {
            const result = await this.composer.forMoment(
                this.briefInputs(kind, facts),
            );
            if (!result) {
                Logger.info(`proactive: moment "${kind}" — rien à dire`);
                return;
            }
            // Le texte du point compte comme « dernier message proactif ».
            this.dedup.record(kind, nowMs, result.text);
        } catch (err) {
            Logger.warn(`proactive: moment "${kind}" non émis — ${err}`);
        }
    }

    private briefInputs(
        momentKind: BriefInputs['momentKind'],
        momentFacts: string,
        scope?: BriefInputs['scope'],
    ): BriefInputs {
        return {
            momentKind,
            momentFacts,
            held: this.held.peek(this.now()),
            situation: this.situation,
            ...(scope ? { scope } : {}),
        };
    }

    /** Point à la demande : texte rendu à l'appelant (ni push ni TTS), marqué
     *  dit et journalisé. Jamais vide. */
    brief(scope?: BriefInputs['scope']): Promise<BriefResult> {
        return this.composer.onDemand(this.briefInputs('on-demand', '', scope));
    }

    /** Ce qui sortirait maintenant — sans LLM, sans marquage, sans retrait. */
    briefPreview(scope?: BriefInputs['scope']): BriefFact[] {
        return this.composer.preview(this.briefInputs('on-demand', '', scope));
    }

    /** Applique un verdict du juge : sortie + journal + dédup. */
    private async applyVerdict(
        input: {
            source: string;
            subject: string;
            facts: string;
            event: Event;
        },
        verdict: JudgeVerdict,
        nowMs: number,
    ): Promise<void> {
        const dedupKey = `${input.event.source}:${input.event.key}`;
        const fp = factsFingerprint(input.event);
        const message = verdict.message || input.facts;
        this.journal.record({
            at: nowMs,
            source: input.source,
            subject: input.subject,
            channel: verdict.channel,
            message,
            reason: verdict.reason,
            event: input.event,
        });
        switch (verdict.channel) {
            case 'speak':
                await this.emit(message);
                this.dedup.record(dedupKey, nowMs, message, fp);
                break;
            case 'notify':
                Logger.info(`proactive: → notification seule « ${message} »`);
                await this.deps.notify(message);
                this.dedup.record(dedupKey, nowMs, message, fp);
                break;
            case 'skip':
                this.dedup.record(dedupKey, nowMs, undefined, fp);
                break;
        }
    }

    /** Porte d'entrée unique (polls, subscribe, POST /events). Une intention
     *  `todo` ne compte que si l'événement a passé les filtres : `accepted`
     *  couvre aussi le retenu par le juge (c'est `consume` qui le met en
     *  file), `held` le retenu par la porte. Le post-it est créé APRÈS la
     *  mise en file, donc l'événement retenu est réécrit en place pour
     *  porter la ligne qui le dit. */
    async ingest(e: Event): Promise<IngestOutcome> {
        const outcome = await this.ingestGate.ingest(e);
        if (this.sourceBrick(e.source).startsWith('external:'))
            this.recordExternal(e, outcome);
        if ((outcome === 'accepted' || outcome === 'held') && e.todo) {
            const r = await createPostitFor(e, {
                registry: this.postits,
                callTool: this.callTool,
                perDay: this.cfg.postitsPerDay ?? DEFAULT_POSTITS_PER_DAY,
                now: this.now,
                log: Logger,
            });
            if (r.created && this.held.has(eventKey(e))) {
                this.held.add(e, this.now());
            }
        }
        return outcome;
    }

    /** Par `ingest` du moteur, pas de la porte : un lot de /events doit
     *  passer par le même crochet qu'un événement seul. */
    async ingestAll(events: Event[]): Promise<Record<IngestOutcome, number>> {
        const counts: Record<IngestOutcome, number> = {
            accepted: 0,
            expired: 0,
            deduplicated: 0,
            held: 0,
            ignored: 0,
        };
        for (const e of events) counts[await this.ingest(e)]++;
        return counts;
    }

    /** Adaptateur pour les sources legacy (CandidateEvent). */
    async processCandidate(ev: CandidateEvent): Promise<void> {
        // Appelé en fire-and-forget par les watchers : il ne doit jamais lever.
        try {
            await this.ingest(fromCandidate(ev, this.now()));
        } catch (err) {
            Logger.error(
                `proactive: processCandidate "${ev.watcherId}:${ev.subject}" — ${err}`,
            );
        }
    }

    heldCount(): number {
        return this.held.size();
    }

    /** Après les filtres d'ingest. Brique `judge` active : l'urgent passe
     *  devant le juge, le reste est retenu pour le prochain point SANS LLM.
     *  Brique off : pipeline historique (seuil de bavardage + reformulation).
     *  Un critique ne dépend jamais d'un verdict LLM : il prend le chemin
     *  historique, qui parle toujours. */
    private async consume(e: Event): Promise<void> {
        const nowMs = this.now();
        const facts = e.facts.length ? e.facts.join(' ') : e.subject;
        const critical = e.importance === 'critique';
        Logger.info(
            `proactive: candidat [${e.source}] key="${e.key}" importance=${e.importance} | "${e.subject}"`,
        );
        const dedupKey = `${e.source}:${e.key}`;
        const fp = factsFingerprint(e);
        if (critical) {
            // Vraie urgence (prod tombée) : pas de juge qui pourrait se taire,
            // pas d'attente — notification + parole si présent, même la nuit.
            if (e.action) await this.tryAction(e.action, nowMs);
            const text = e.facts.length
                ? `${e.subject}. ${e.facts[0]}`
                : e.subject;
            const channel = await this.pushNow(text, true, true);
            this.journal.record({
                at: nowMs,
                source: e.source,
                subject: e.key,
                channel,
                message: text,
                reason: 'critique : sortie immédiate sans juge',
                event: e,
            });
            this.dedup.record(dedupKey, nowMs, text, fp);
            return;
        }
        if (isBrickEnabled(this.cfg, 'judge')) {
            // Agir et parler sont indépendants : l'action whitelistée (avec sa
            // garde anti-conflit) est tentée que l'événement soit dit ou
            // retenu — seul le pipeline historique lie l'action au seuil.
            if (e.action) await this.tryAction(e.action, nowMs);
            if (e.importance !== 'urgent') {
                Logger.info(
                    `proactive: ⏸ retenu "${e.key}" (importance ${e.importance} → matière du prochain point)`,
                );
                this.held.add(e, nowMs);
                this.dedup.record(dedupKey, nowMs, undefined, fp);
                return;
            }
            const verdict = await this.judge.evaluate(
                {
                    source: e.source,
                    subject: e.key,
                    facts,
                    importance: e.importance,
                    kind: 'event',
                } satisfies JudgeInput,
                this.situation,
                this.lastDeltas,
            );
            await this.applyVerdict(
                { source: e.source, subject: e.key, facts, event: e },
                verdict,
                nowMs,
            );
            return;
        }
        // Pipeline historique (juge désactivé) : seuil de bavardage puis reformulation.
        if (!critical && !passesThreshold(e.importance, this.cfg.chattiness)) {
            Logger.info(
                `proactive: ⏸ retenu "${e.key}" (importance ${e.importance} sous le seuil ${this.cfg.chattiness})`,
            );
            this.held.add(e, nowMs);
            this.dedup.record(dedupKey, nowMs, undefined, fp);
            return;
        }
        // L'action n'est tentée que si l'événement passe le seuil : un retenu ne
        // déclenche rien (contrat de l'ancien pipeline).
        if (e.action) await this.tryAction(e.action, nowMs);
        const lastMessage = this.dedup.lastMessage(dedupKey);
        const message = await this.phrase(
            { template: e.template, facts },
            lastMessage,
        );
        if (!message) {
            // RIEN : rien de neuf à dire — on ré-arme le cooldown (sans toucher
            // au dernier message) pour ne pas re-consulter le LLM à chaque poll.
            Logger.info(`proactive: ✕ RIEN "${e.key}" — cooldown ré-armé`);
            this.dedup.record(dedupKey, nowMs, undefined, fp);
            return;
        }
        Logger.info(`proactive: ✓ ÉMET "${e.key}" → "${message}"`);
        await this.emit(message);
        this.dedup.record(dedupKey, nowMs, message, fp);
    }

    private async phrase(
        ev: { template?: string; facts: string },
        lastMessage?: string,
    ): Promise<string | null> {
        const label = ev.facts.slice(0, 40);
        if (ev.template) {
            Logger.info(
                `proactive: formulation court-circuitée (template) "${label}" → "${ev.template}"`,
            );
            return ev.template;
        }
        try {
            const sys = this.cfg.prompts?.phrase ?? DEFAULT_PHRASE_PROMPT;
            const user =
                lastMessage && lastMessage.length > 0
                    ? `Déjà signalé récemment : "${lastMessage}". Situation actuelle : ${ev.facts}`
                    : ev.facts;
            Logger.info(
                `proactive: LLM formulation "${label}" — prompt user="${user}"` +
                    (lastMessage
                        ? ` (contexte: dernier message="${lastMessage}")`
                        : ' (pas de message antérieur)'),
            );
            const out = (await this.deps.complete(sys, user)).trim();
            Logger.info(`proactive: LLM a répondu "${label}" → "${out}"`);
            if (!out || out.toUpperCase() === 'RIEN') return null;
            return out;
        } catch (err) {
            Logger.warn(
                `proactive: formulation échouée, repli sur facts — ${err}`,
            );
            return ev.facts;
        }
    }

    private isQuiet(): boolean {
        return isQuietHours(new Date(this.now()), this.cfg.quietHours);
    }

    /**
     * Sortie immédiate, sans juge : `critique` (prod tombée) et alertes de
     * règle courrier. Notification toujours ; parole seulement si présent et
     * hors heures de silence — sauf `force` (critique : on réveille).
     */
    private async pushNow(
        text: string,
        wantSpeak: boolean,
        force = false,
    ): Promise<'speak' | 'notify'> {
        const presence = this.deps.presenceState();
        const speak =
            wantSpeak && presence === 'home' && (force || !this.isQuiet());
        Logger.info(
            `proactive: sortie immédiate → notification${
                speak ? ' + TTS' : ''
            } « ${text.slice(0, 80)} »`,
        );
        await this.deps.notify(text);
        if (speak) await this.deps.speak(text);
        return speak ? 'speak' : 'notify';
    }

    /**
     * Mail que le lecteur IA juge à signaler : sortie immédiate (notification,
     * parole si présent et hors nuit) — LE canal d'alerte, plafonné à
     * MAIL_NOTIFY_PER_DAY par jour —, puis mise en file pour l'événement
     * `utile` du connecteur (post-it, prochain point).
     */
    async notifyMail(
        m: { mailId: string; from: string; subject: string; box?: string },
        item: ReaderItem,
    ): Promise<void> {
        const allowed = this.reserveMailNotify();
        pushBounded(this.pendingMailNotify, {
            ...m,
            item,
            ...(allowed ? {} : { capped: true }),
        });
        const who = senderName(m.from);
        const text = `Courrier : « ${m.subject} » de ${who}${
            item.reason ? ` — ${item.reason}` : ''
        }`;
        if (!allowed) {
            Logger.info(
                `proactive: courrier ${m.mailId} non poussé (plafond ${MAIL_NOTIFY_PER_DAY}/jour, ${this.mailCappedCount} retenu(s) aujourd'hui)`,
            );
            // Une seule entrée de journal par jour (le premier mail plafonné) :
            // les suivants restent comptés et en file pour le prochain point.
            if (this.mailCappedCount > 1) return;
            this.journal.record({
                at: this.now(),
                source: 'mail-reader',
                subject: m.mailId,
                channel: 'hold',
                message: text,
                reason: `Notification plafonnée (${MAIL_NOTIFY_PER_DAY}/jour) — ${item.reason}`,
            });
            return;
        }
        try {
            const channel = await this.pushNow(text, true);
            this.journal.record({
                at: this.now(),
                source: 'mail-reader',
                subject: m.mailId,
                channel,
                message: text,
                reason: item.reason,
            });
        } catch (err) {
            Logger.warn(`proactive: alerte courrier ${m.mailId} — ${err}`);
        }
    }

    private async emit(text: string): Promise<void> {
        const presence = this.deps.presenceState();
        const willSpeak = presence === 'home';
        Logger.info(
            `proactive: sortie → notification FCM${
                willSpeak ? ' + TTS' : ''
            } ` + `(présence=${presence})`,
        );
        await this.deps.notify(text);
        if (willSpeak) {
            await this.deps.speak(text);
        }
    }

    /** Réglages effectifs d'un connecteur : défauts déclarés ← section legacy ← écarts de brique. */
    private connectorSettings(def: ConnectorDef): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const s of def.settings ?? []) out[s.key] = s.default;
        // Ensemble FERMÉ : seules ces quatre sections historiques de
        // proactive.json sont fusionnées, sinon un futur connecteur hériterait
        // d'un champ de config homonyme qui ne le concerne pas.
        if (LEGACY_SECTIONS.has(def.id)) {
            const legacy = (
                this.cfg as unknown as Record<
                    string,
                    Record<string, unknown> | undefined
                >
            )[def.id];
            if (legacy && typeof legacy === 'object')
                Object.assign(out, legacy);
        }
        Object.assign(out, this.cfg.bricks?.[def.id]?.settings ?? {});
        return out;
    }

    /** Cadence effective d'un connecteur (réglage de brique ← définition) —
     *  `undefined` = connecteur jamais pollé (événementiel) ou inconnu. */
    connectorPollMinutes(id: string): number | undefined {
        const def = this.connectors.find((c) => c.id === id);
        if (!def) return undefined;
        return (
            Number(this.connectorSettings(def).pollMinutes ?? 0) ||
            def.pollMinutes
        );
    }

    private buildRunner(): ConnectorRunner {
        return new ConnectorRunner({
            // Le runner lit `def.pollMinutes` : la cadence réglée dans la
            // brique doit donc être reportée sur la définition elle-même.
            connectors: this.connectors.map((d) => ({
                ...d,
                pollMinutes: this.connectorPollMinutes(d.id),
            })),
            isEnabled: (id) => isBrickEnabled(this.cfg, id),
            settings: (def) => this.connectorSettings(def),
            callTool: this.callTool,
            presence: () => this.deps.presenceState(),
            ingest: (e) => this.ingest(e),
            now: this.now,
        });
    }

    start(): void {
        if (!this.cfg.enabled) {
            Logger.info('proactive: désactivé (config)');
            return;
        }
        this.runner = this.buildRunner();
        this.runner.start();
        this.situationTimer = setInterval(
            () => void this.situationTick(),
            SITUATION_POLL_MS,
        );
        void this.situationTick();
        Logger.info(
            `proactive: démarré — connecteurs=[${this.runner
                .activeIds()
                .join(', ')}] | chattiness=${this.cfg.chattiness} ` +
                `(laisse passer ${
                    this.cfg.chattiness === 'discret'
                        ? 'urgent+'
                        : this.cfg.chattiness === 'normal'
                        ? 'utile+'
                        : 'info+'
                }) | quietHours=${this.cfg.quietHours.start}–${
                    this.cfg.quietHours.end
                } ` +
                `| cooldown=${this.cfg.defaultCooldownMin}min`,
        );
    }

    stop(): void {
        this.runner?.stop();
        this.runner = null;
        if (this.situationTimer) clearInterval(this.situationTimer);
        this.situationTimer = undefined;
    }

    /** Dernier message proactif réellement communiqué (tous sujets), ou null. */
    getLastMessage(): { message: string; at: number } | null {
        return this.dedup.latest();
    }

    /** Requête Gmail des mails « importants » de la tuile du dashboard. Le
     *  connecteur courrier ne la déclare plus (le facteur lit la boîte de
     *  réception) : un `query` hérité (section legacy ← brique) gagne encore,
     *  sinon le défaut historique. */
    getMailQuery(): string | undefined {
        const def = this.connectors.find((c) => c.id === 'mail');
        const q = def
            ? this.connectorSettings(def).query
            : brickSetting(this.cfg, 'mail', 'query', this.cfg.mail?.query);
        return typeof q === 'string' && q ? q : DASHBOARD_MAIL_QUERY;
    }

    /** Re-read config from disk, rebuild the runner, and restart. Used by
     *  PUT /proactive to apply changes without a full orchestrator restart. */
    reload(): ProactiveConfig {
        this.stop();
        this.cfg = loadConfig();
        // Les connecteurs relisent leurs réglages via `connectorSettings` à la
        // construction du runner — rien d'autre à reconstruire.
        this.start();
        return this.cfg;
    }

    private async tryAction(
        pa: { id: string; tag: string },
        nowMs: number,
    ): Promise<void> {
        const wl = this.cfg.whitelist.find((w) => w.id === pa.id);
        if (!wl) {
            Logger.warn(`proactive: action "${pa.id}" non whitelistée`);
            return;
        }
        const blocked = isActionBlocked({
            tag: wl.tag,
            now: nowMs,
            windowMs: this.cfg.automationGuardWindowMin * 60_000,
            history: loadHistory(),
            enabledAutomationTags: loadAutomations()
                .filter((a) => a.enabled && a.tag)
                .map((a) => a.tag as string),
        });
        if (blocked) {
            Logger.info(
                `proactive: action "${pa.id}" bridée (garde tag=${wl.tag})`,
            );
            return;
        }
        try {
            if ('sceneId' in wl.action) {
                await this.deps.runScene(wl.action.sceneId);
            } else {
                await this.deps.deviceHandler(
                    wl.action.tool,
                    wl.action.args ?? {},
                );
            }
            Logger.info(`proactive: action "${pa.id}" exécutée`);
        } catch (err) {
            Logger.warn(`proactive: action "${pa.id}" a échoué — ${err}`);
        }
    }
}

export function initProactive(deps: ProactiveDeps): ProactiveEngine {
    const cfg = loadConfig();
    const engine = new ProactiveEngine(cfg, deps);
    // Moment « retour » : ancré sur la transition de présence, pas sur le tick.
    deps.subscribePresence((prev, next) => {
        if (prev !== 'home' && next === 'home') {
            void engine
                .situationTick()
                .then(() =>
                    isBrickEnabled(loadConfig(), 'moment-return')
                        ? engine.handleMoment(
                              'moment-return',
                              returnMomentFacts(engine.getSituation()),
                          )
                        : undefined,
                );
        }
    });
    engine.start();
    return engine;
}
