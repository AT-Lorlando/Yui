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
import { createWeatherWatcher } from './watchers/weather';
import { createPresenceWatcher } from './watchers/presence';
import { createCalendarWatcher } from './watchers/calendar';
import { createMailWatcher } from './watchers/mail';
import { createDeliveriesWatcher } from './watchers/deliveries';
import { isBrickEnabled, bricksView, brickSetting } from './bricks';
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
import type { MailCategory, TriageDoubt } from './mail/concierge';
import { saveConfig } from './config';
import type { MomentKind, MomentState } from './moments';
import type {
    CandidateEvent,
    ProactiveConfig,
    ProactiveDeps,
    Watcher,
} from './types';

const DEDUP_FILE = dataPath('proactive-dedup.json');
/** Cadence de reconstruction du journal de situation (lectures store, pas cher). */
const SITUATION_POLL_MS = 2 * 60_000;
const DEFAULT_BUDGET_PER_DAY = 3;
/** Plafond par source et par heure — barrière anti-flood sans LLM (spec §5.3.4). */
const DEFAULT_MAX_PER_HOUR = 6;

export class ProactiveEngine {
    private dedup: Dedup;
    private held: HeldQueue;
    private rate = new RateWindow();
    private ingestGate: Ingest;
    private watchers: Watcher[] = [];
    private now: () => number;
    private situationTimer?: ReturnType<typeof setInterval>;
    readonly journal: ProactiveJournal;
    readonly concierge: MailConcierge;
    private conciergeTimer?: ReturnType<typeof setInterval>;
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
                    source,
                    'maxPerHour',
                    DEFAULT_MAX_PER_HOUR,
                ),
            quietHours: () => this.cfg.quietHours,
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
            onDoubts: (doubts) => void this.notifyDoubts(doubts),
            now: this.now,
        });
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

    /** Doutes de tri → une notification (jamais parlée), via le juge. */
    private async notifyDoubts(doubts: TriageDoubt[]): Promise<void> {
        const n = doubts.length;
        const sample = doubts
            .slice(0, 2)
            .map((d) => `« ${d.subject.slice(0, 50)} »`)
            .join(', ');
        await this.processCandidate({
            watcherId: 'mail-concierge',
            subject: 'mail-doubts',
            importance: 'utile',
            facts: `Le concierge courrier hésite sur ${n} mail(s) (${sample}) et propose des règles de tri — à trancher dans l'app, page Courrier.`,
            template: `J'ai un doute sur ${n} mail${
                n > 1 ? 's' : ''
            } — tranche-les dans la page Courrier.`,
            cooldownMs: 3 * 3600_000,
        });
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
            const next = await buildSituation({
                callTool: (t, a) => this.deps.deviceHandler(t, a),
                presenceState: () => this.deps.presenceState(),
                now: this.now,
            });
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

    setWatchers(ws: Watcher[]): void {
        this.watchers = ws;
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
        await this.ingest(fromCandidate(ev, this.now()));
    }

    heldCount(): number {
        return this.held.size();
    }

    /** Les retenus, rendus au prochain moment (et vidés). */
    heldForMoment(): string {
        const items = this.held.take(this.now());
        return items
            .map(
                (e) =>
                    `- [${e.source}] ${e.subject}${
                        e.facts.length ? ` (${e.facts.join(' ; ')})` : ''
                    }`,
            )
            .join('\n');
    }

    /** Après les filtres d'ingest : juge à budget, ou pipeline legacy si la brique est off. */
    private async consume(e: Event): Promise<void> {
        const nowMs = this.now();
        const facts = e.facts.length ? e.facts.join(' ') : e.subject;
        const critical = e.importance === 'critique';
        Logger.info(
            `proactive: candidat [${e.source}] key="${e.key}" importance=${e.importance} | "${e.subject}"`,
        );
        if (e.action) await this.tryAction(e.action, nowMs);
        if (!critical && isBrickEnabled(this.cfg, 'judge')) {
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
            this.dedup.record(`${e.source}:${e.key}`, nowMs);
            return;
        }
        const lastMessage = this.dedup.lastMessage(`${e.source}:${e.key}`);
        const message = await this.phrase(
            { template: e.template, facts },
            lastMessage,
        );
        if (!message) {
            // RIEN : rien de neuf à dire — on ré-arme le cooldown (sans toucher
            // au dernier message) pour ne pas re-consulter le LLM à chaque poll.
            Logger.info(`proactive: ✕ RIEN "${e.key}" — cooldown ré-armé`);
            this.dedup.record(`${e.source}:${e.key}`, nowMs);
            return;
        }
        Logger.info(`proactive: ✓ ÉMET "${e.key}" → "${message}"`);
        await this.emit(message);
        this.dedup.record(`${e.source}:${e.key}`, nowMs, message);
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

    start(): void {
        if (!this.cfg.enabled) {
            Logger.info('proactive: désactivé (config)');
            return;
        }
        for (const w of this.watchers) {
            try {
                w.start((c) => void this.processCandidate(c));
            } catch (err) {
                Logger.warn(
                    `proactive: watcher "${w.id}" n'a pas démarré — ${err}`,
                );
            }
        }
        this.situationTimer = setInterval(
            () => void this.situationTick(),
            SITUATION_POLL_MS,
        );
        void this.situationTick();
        if (isBrickEnabled(this.cfg, 'mail-concierge')) {
            const pollMs = (this.cfg.concierge?.pollMinutes ?? 30) * 60_000;
            this.conciergeTimer = setInterval(
                () => void this.concierge.scan().catch(() => {}),
                pollMs,
            );
            void this.concierge.scan().catch(() => {});
            Logger.info(
                `proactive: concierge courrier actif (poll ${Math.round(
                    pollMs / 60000,
                )} min)`,
            );
        }
        Logger.info(
            `proactive: démarré — watchers=[${this.watchers
                .map((w) => w.id)
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
        for (const w of this.watchers) {
            try {
                w.stop();
            } catch {
                /* best-effort */
            }
        }
        if (this.situationTimer) clearInterval(this.situationTimer);
        if (this.conciergeTimer) clearInterval(this.conciergeTimer);
    }

    /** Dernier message proactif réellement communiqué (tous sujets), ou null. */
    getLastMessage(): { message: string; at: number } | null {
        return this.dedup.latest();
    }

    /** Requête Gmail configurée pour le watcher mail (mails « importants »). */
    getMailQuery(): string | undefined {
        return this.cfg.mail?.query;
    }

    /** Re-read config from disk, rebuild watchers, and restart. Used by
     *  PUT /proactive to apply changes without a full orchestrator restart. */
    reload(): ProactiveConfig {
        this.stop();
        this.cfg = loadConfig();
        this.setWatchers(buildWatchers(this.cfg, this.deps));
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

function buildWatchers(cfg: ProactiveConfig, deps: ProactiveDeps): Watcher[] {
    const watchers: Watcher[] = [];
    const on = (brick: string) => isBrickEnabled(cfg, brick);
    if (cfg.weather && on('weather'))
        watchers.push(createWeatherWatcher(cfg.weather, deps));
    if (on('presence')) watchers.push(createPresenceWatcher(deps));
    if (cfg.calendar && on('calendar'))
        watchers.push(createCalendarWatcher(cfg.calendar, deps));
    if (cfg.mail && on('mail-important'))
        watchers.push(createMailWatcher(cfg.mail, deps));
    if (cfg.deliveries && on('deliveries'))
        watchers.push(createDeliveriesWatcher(cfg.deliveries, deps));
    return watchers;
}

export function initProactive(deps: ProactiveDeps): ProactiveEngine {
    const cfg = loadConfig();
    const engine = new ProactiveEngine(cfg, deps);
    engine.setWatchers(buildWatchers(cfg, deps));
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
