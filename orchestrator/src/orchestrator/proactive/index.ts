import * as path from 'path';
import Logger from '../../logger';
import { dataPath } from '@yui/shared';
import { passesThreshold } from './gates';
import { Dedup } from './dedup';
import { HeldQueue } from './held';
import { RateWindow } from './rate';
import { Ingest } from './ingest';
import type { IngestOutcome } from './ingest';
import { factsFingerprint, fromCandidate } from './events';
import type { Event } from './events';
import { isActionBlocked } from './guard';
import { loadHistory } from '../history';
import { loadAutomations } from '../automations';
import { loadConfig, DEFAULT_PHRASE_PROMPT } from './config';
import { ConnectorRunner } from './runner';
import { buildConnectors } from './connectors';
import type { ConnectorDef } from './connector';
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
import {
    buildSituation,
    diffSituation,
    loadSituation,
    saveSituation,
} from './situation';
import type { Situation } from './situation';
import { detectMoments, returnMomentFacts } from './moments';
import { MailConcierge } from './mail/concierge';
import type { MailCategory } from './mail/concierge';
import { saveConfig } from './config';
import type { MomentKind, MomentState } from './moments';
import type { CandidateEvent, ProactiveConfig, ProactiveDeps } from './types';

const DEDUP_FILE = dataPath('proactive-dedup.json');
/** Cadence de reconstruction du journal de situation (lectures store, pas cher). */
const SITUATION_POLL_MS = 2 * 60_000;
const DEFAULT_BUDGET_PER_DAY = 3;
/** Plafond par source et par heure — barrière anti-flood sans LLM (spec §5.3.4). */
const DEFAULT_MAX_PER_HOUR = 6;
/** Sections historiques de proactive.json fusionnées dans les réglages du
 *  connecteur de même id (config d'avant les briques ; jamais étendu). */
const LEGACY_SECTIONS = new Set(['weather', 'calendar', 'mail', 'deliveries']);

export class ProactiveEngine {
    private dedup: Dedup;
    private held: HeldQueue;
    private rate = new RateWindow();
    private ingestGate: Ingest;
    private runner: ConnectorRunner | null = null;
    private connectors: ConnectorDef[] = [];
    private now: () => number;
    private situationTimer?: ReturnType<typeof setInterval>;
    readonly journal: ProactiveJournal;
    readonly concierge: MailConcierge;
    private judge: Judge;
    private situation: Situation | null;
    private momentState: MomentState = { firedDepartures: [] };
    private lastDeltas: string[] = [];

    constructor(
        private cfg: ProactiveConfig,
        private deps: ProactiveDeps,
        opts: {
            dedup?: Dedup;
            journal?: ProactiveJournal;
            held?: HeldQueue;
        } = {},
    ) {
        this.now = deps.now ?? (() => Date.now());
        this.dedup = opts.dedup ?? new Dedup(DEDUP_FILE);
        this.journal = opts.journal ?? new ProactiveJournal();
        this.held = opts.held ?? new HeldQueue(HeldQueue.defaultFile());
        this.situation = loadSituation();
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
        });
        this.judge = new Judge({
            complete: (sys, user) => this.deps.complete(sys, user),
            journal: this.journal,
            budgetPerDay: () => this.cfg.budgetPerDay ?? DEFAULT_BUDGET_PER_DAY,
            now: this.now,
        });
        this.concierge = new MailConcierge({
            deviceHandler: (t, a) => this.deps.deviceHandler(t, a),
            complete: (sys, user) => this.deps.complete(sys, user),
            getRules: () => this.cfg.concierge?.rules ?? [],
            addRule: (rule) => {
                const rules = [
                    ...(this.cfg.concierge?.rules ?? []).filter(
                        (r) => r.match !== rule.match,
                    ),
                    rule,
                ];
                this.patchConcierge({ rules });
            },
            getAutoCategories: () =>
                (this.cfg.concierge?.autoCategories ?? []) as MailCategory[],
            getPromptRules: () => this.cfg.concierge?.promptRules ?? [],
            addPromptRule: (text) => {
                const promptRules = [
                    ...(this.cfg.concierge?.promptRules ?? []).filter(
                        (r) => r !== text,
                    ),
                    text,
                ];
                this.patchConcierge({ promptRules });
            },
            getCustomCategories: () =>
                this.cfg.concierge?.customCategories ?? [],
            addCustomCategory: (c) => {
                const customCategories = [
                    ...(this.cfg.concierge?.customCategories ?? []).filter(
                        (x) => x.id !== c.id,
                    ),
                    c,
                ];
                this.patchConcierge({ customCategories });
            },
            now: this.now,
        });
        this.connectors = buildConnectors({
            concierge: this.concierge,
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

    /** La brique qui gouverne une source : le connecteur/moment lui-même s'il
     *  en a une, sinon la brique implicite `external:<source>` (Task 14). */
    private sourceBrick(source: string): string {
        return this.connectors.some((c) => c.id === source) ||
            source.startsWith('moment-')
            ? source
            : `external:${source}`;
    }

    /** Une app externe inconnue apparaît sur /proactive dès son premier
     *  événement — écrit une fois, jamais réécrite ensuite. */
    private declareExternal(source: string): void {
        const id = this.sourceBrick(source);
        if (!id.startsWith('external:') || this.cfg.bricks?.[id]) return;
        this.cfg.bricks = {
            ...(this.cfg.bricks ?? {}),
            [id]: { enabled: true, settings: {} },
        };
        try {
            saveConfig({ bricks: this.cfg.bricks });
        } catch (err) {
            Logger.warn(`proactive: brique ${id} non persistée — ${err}`);
        }
    }

    private patchConcierge(
        patch: Partial<NonNullable<ProactiveConfig['concierge']>>,
    ): void {
        this.cfg.concierge = { ...this.cfg.concierge, ...patch };
        try {
            saveConfig({ concierge: this.cfg.concierge });
        } catch (err) {
            Logger.warn(`concierge: config non persistée — ${err}`);
        }
    }

    /** Résumé du tri courrier pour le dashboard (tuile Briefing). */
    getTriageSummary(): {
        pendingCount: number;
        doubtCount: number;
        actions: Array<{ subject: string; from: string }>;
        classifiedToday: number;
    } {
        const st = this.concierge.getState();
        const today = new Date(this.now()).toDateString();
        return {
            pendingCount: this.concierge.pending().length,
            doubtCount: this.concierge.openDoubts().length,
            actions: st.proposals
                .filter((p) => p.category === 'action')
                .slice(-8)
                .map((p) => ({ subject: p.subject, from: p.from })),
            classifiedToday: st.proposals.filter(
                (p) =>
                    p.appliedAt &&
                    new Date(p.appliedAt).toDateString() === today,
            ).length,
        };
    }

    getBricks() {
        return bricksView(this.cfg);
    }

    getJournal(limit = 50): JournalEntry[] {
        return this.journal.list(limit);
    }

    setFeedback(id: string, feedback: Feedback): boolean {
        return this.journal.setFeedback(id, feedback);
    }

    getSituation(): Situation | null {
        return this.situation;
    }

    /** Tick du journal de situation : reconstruit, diffe, détecte les moments. */
    async situationTick(): Promise<void> {
        try {
            const next = await buildSituation(
                {
                    callTool: (t, a) => this.deps.deviceHandler(t, a),
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
            for (const m of moments) {
                await this.handleMoment(m.kind, m.facts);
            }
        } catch (err) {
            Logger.warn(`proactive: situation tick — ${err}`);
        }
    }

    /** Moment de vie détecté → le juge compose (ou se tait). */
    async handleMoment(
        kind: MomentKind | string,
        facts: string,
    ): Promise<void> {
        const nowMs = this.now();
        // Un moment par fenêtre de 2 h max, quoi qu'il arrive.
        if (this.dedup.isDuplicate(kind, nowMs, 2 * 3600_000)) return;
        Logger.info(`proactive: moment "${kind}" — ${facts.slice(0, 120)}`);
        const heldFacts = this.heldForMoment();
        const factsWithHeld = heldFacts
            ? `${facts}\nRetenu depuis la dernière fois :\n${heldFacts}`
            : facts;
        const verdict = await this.judge.evaluate(
            {
                source: kind,
                subject: kind,
                facts: factsWithHeld,
                importance: 'utile',
                kind: 'moment',
                budgetExempt: true,
            },
            this.situation,
            this.lastDeltas,
        );
        await this.applyVerdict(
            { source: kind, subject: kind, facts: factsWithHeld },
            verdict,
            nowMs,
        );
        // Les retenus ne sont vidés que s'ils ont VRAIMENT été livrés : un
        // verdict hold/skip (ou un repli du juge) doit les garder pour le
        // prochain moment, sinon ils disparaissent sans jamais avoir été dits.
        if (verdict.channel === 'speak' || verdict.channel === 'notify') {
            this.clearHeld();
        }
    }

    /** Applique un verdict du juge : sortie + journal + dédup. */
    private async applyVerdict(
        input: {
            source: string;
            subject: string;
            facts: string;
            event?: Event;
        },
        verdict: JudgeVerdict,
        nowMs: number,
    ): Promise<void> {
        // Les événements du bus sont dédupliqués par `source:key` ; les moments
        // gardent leur clé nue.
        const dedupKey = input.event
            ? `${input.event.source}:${input.event.key}`
            : input.subject;
        const fp = input.event ? factsFingerprint(input.event) : undefined;
        const message = verdict.message || input.facts;
        this.journal.record({
            at: nowMs,
            source: input.source,
            subject: input.subject,
            channel: verdict.channel,
            message,
            reason: verdict.reason,
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
            case 'hold':
                if (input.event) this.held.add(input.event, nowMs);
                this.dedup.record(dedupKey, nowMs, undefined, fp);
                break;
            case 'skip':
                this.dedup.record(dedupKey, nowMs, undefined, fp);
                break;
        }
    }

    /** Porte d'entrée unique (polls, subscribe, POST /events). */
    ingest(e: Event): Promise<IngestOutcome> {
        return this.ingestGate.ingest(e);
    }

    ingestAll(events: Event[]): Promise<Record<IngestOutcome, number>> {
        return this.ingestGate.ingestAll(events);
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

    /** Les retenus, mis en forme pour le prochain moment. Sans effet de bord. */
    heldForMoment(): string {
        return this.held
            .peek(this.now())
            .map(
                (e) =>
                    `- [${e.source}] ${e.subject}${
                        e.facts.length ? ` (${e.facts.join(' ; ')})` : ''
                    }`,
            )
            .join('\n');
    }

    /** Vide la file des retenus — à n'appeler qu'après une livraison effective. */
    clearHeld(): void {
        this.held.take(this.now());
    }

    /** Après les filtres d'ingest : juge à budget, ou pipeline legacy si la brique est off. */
    private async consume(e: Event): Promise<void> {
        const nowMs = this.now();
        const facts = e.facts.length ? e.facts.join(' ') : e.subject;
        const critical = e.importance === 'critique';
        Logger.info(
            `proactive: candidat [${e.source}] key="${e.key}" importance=${e.importance} | "${e.subject}"`,
        );
        const dedupKey = `${e.source}:${e.key}`;
        const fp = factsFingerprint(e);
        if (!critical && isBrickEnabled(this.cfg, 'judge')) {
            if (e.action) await this.tryAction(e.action, nowMs);
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
            callTool: (t, a) => this.deps.deviceHandler(t, a),
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

    /** Requête Gmail des mails « importants » — résolue EXACTEMENT comme le
     *  poll du connecteur (défaut déclaré ← section legacy ← brique), sinon le
     *  dashboard chercherait une autre requête que celle réellement pollée. */
    getMailQuery(): string | undefined {
        const def = this.connectors.find((c) => c.id === 'mail');
        const q = def
            ? this.connectorSettings(def).query
            : brickSetting(this.cfg, 'mail', 'query', this.cfg.mail?.query);
        return typeof q === 'string' && q ? q : undefined;
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
