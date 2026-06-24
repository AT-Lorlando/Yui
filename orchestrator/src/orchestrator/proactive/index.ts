import * as path from 'path';
import Logger from '../../logger';
import { dataPath } from '@yui/shared';
import { isQuietHours, passesThreshold } from './gates';
import { Dedup } from './dedup';
import { DigestBuffer, isDigestDue } from './digest';
import { isActionBlocked } from './guard';
import { loadHistory } from '../history';
import { loadAutomations } from '../automations';
import {
    loadConfig,
    DEFAULT_PHRASE_PROMPT,
    DEFAULT_DIGEST_PROMPT,
} from './config';
import { createWeatherWatcher } from './watchers/weather';
import { createPresenceWatcher } from './watchers/presence';
import { createCalendarWatcher } from './watchers/calendar';
import { createMailWatcher } from './watchers/mail';
import type {
    CandidateEvent,
    ProactiveConfig,
    ProactiveDeps,
    Watcher,
} from './types';

const DEDUP_FILE = dataPath('proactive-dedup.json');

export class ProactiveEngine {
    private dedup: Dedup;
    private digest: DigestBuffer;
    private watchers: Watcher[] = [];
    private now: () => number;
    private digestTimer?: ReturnType<typeof setInterval>;

    constructor(
        private cfg: ProactiveConfig,
        private deps: ProactiveDeps,
        digest?: DigestBuffer,
        dedup?: Dedup,
    ) {
        this.now = deps.now ?? (() => Date.now());
        this.digest = digest ?? new DigestBuffer();
        this.dedup = dedup ?? new Dedup(DEDUP_FILE);
    }

    setWatchers(ws: Watcher[]): void {
        this.watchers = ws;
    }

    async processCandidate(ev: CandidateEvent): Promise<void> {
        try {
            const nowMs = this.now();
            const nowDate = new Date(nowMs);
            const critical = ev.importance === 'critique';

            Logger.info(
                `proactive: candidat reçu [${ev.watcherId}] subject="${ev.subject}" ` +
                    `importance=${ev.importance}${
                        critical ? ' (critique → court-circuite les gates)' : ''
                    } | facts="${ev.facts}"`,
            );

            // 1. heures de silence
            if (!critical && isQuietHours(nowDate, this.cfg.quietHours)) {
                Logger.info(
                    `proactive: → DIGEST "${ev.subject}" (heures de silence ` +
                        `${this.cfg.quietHours.start}–${this.cfg.quietHours.end}, ` +
                        `il est ${nowDate.getHours()}:${String(
                            nowDate.getMinutes(),
                        ).padStart(2, '0')})`,
                );
                this.digest.add(ev);
                return;
            }
            // 2. seuil de bavardage
            if (
                !critical &&
                !passesThreshold(ev.importance, this.cfg.chattiness)
            ) {
                Logger.info(
                    `proactive: → DIGEST "${ev.subject}" (importance ${ev.importance} ` +
                        `sous le seuil chattiness=${this.cfg.chattiness})`,
                );
                this.digest.add(ev);
                return;
            }
            // 3. anti-répétition
            const cooldown =
                ev.cooldownMs ?? this.cfg.defaultCooldownMin * 60_000;
            if (this.dedup.isDuplicate(ev.subject, nowMs, cooldown)) {
                Logger.info(
                    `proactive: ⊘ IGNORÉ "${ev.subject}" (anti-répétition, ` +
                        `cooldown ${Math.round(
                            cooldown / 60_000,
                        )}min déjà signalé récemment)`,
                );
                return;
            }

            // 4 + 6. action whitelist (avec garde anti-conflit)
            if (ev.proposedAction) {
                Logger.info(
                    `proactive: action proposée "${ev.proposedAction.id}" ` +
                        `(tag=${ev.proposedAction.tag}) pour "${ev.subject}"`,
                );
                await this.tryAction(ev.proposedAction, nowMs);
            }

            // 5. formulation (avec le dernier message comme contexte)
            const lastMessage = this.dedup.lastMessage(ev.subject);
            const message = await this.phrase(ev, lastMessage);
            if (!message) {
                // RIEN : rien de neuf à dire — on ré-arme le cooldown (sans
                // toucher au dernier message) pour ne pas re-consulter le LLM
                // à chaque poll.
                Logger.info(
                    `proactive: ✕ RIEN "${ev.subject}" — le LLM juge qu'il n'y a ` +
                        `rien de neuf à dire, cooldown ré-armé`,
                );
                this.dedup.record(ev.subject, nowMs);
                return;
            }

            // 7. sortie
            Logger.info(`proactive: ✓ ÉMET "${ev.subject}" → "${message}"`);
            await this.emit(message);

            // 8. trace
            this.dedup.record(ev.subject, nowMs, message);
            // 9. anti-doublon digest : ce sujet vient d'être dit en direct, on
            // le retire du buffer pour que le digest du matin ne le répète pas.
            if (this.digest.remove(ev.subject)) {
                Logger.info(
                    `proactive: "${ev.subject}" retiré du digest (déjà notifié en direct)`,
                );
            }
        } catch (err) {
            Logger.error(
                `proactive: processCandidate "${ev.subject}" — ${err}`,
            );
        }
    }

    private async phrase(
        ev: CandidateEvent,
        lastMessage?: string,
    ): Promise<string | null> {
        if (ev.template) {
            Logger.info(
                `proactive: formulation court-circuitée (template) "${ev.subject}" → "${ev.template}"`,
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
                `proactive: LLM formulation "${ev.subject}" — prompt user="${user}"` +
                    (lastMessage
                        ? ` (contexte: dernier message="${lastMessage}")`
                        : ' (pas de message antérieur)'),
            );
            const out = (await this.deps.complete(sys, user)).trim();
            Logger.info(`proactive: LLM a répondu "${ev.subject}" → "${out}"`);
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
        this.digestTimer = setInterval(
            () => void this.maybeFlushDigest(),
            60_000,
        );
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
                `| digestTime=${this.cfg.digestTime} | cooldown=${this.cfg.defaultCooldownMin}min`,
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
        if (this.digestTimer) clearInterval(this.digestTimer);
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

    async maybeFlushDigest(): Promise<void> {
        const nowMs = this.now();
        if (
            !isDigestDue(
                new Date(nowMs),
                this.cfg.digestTime,
                this.digest.lastFlush(),
            )
        ) {
            return;
        }
        const events = this.digest.takeAll(nowMs);
        if (events.length === 0) return;
        Logger.info(
            `proactive: flush du digest (${events.length} événement(s) groupé(s) : ` +
                `${events.map((e) => e.subject).join(', ')})`,
        );
        const facts = events.map((e) => `- ${e.facts}`).join('\n');
        let message: string;
        try {
            const sys = this.cfg.prompts?.digest ?? DEFAULT_DIGEST_PROMPT;
            Logger.info(`proactive: LLM digest — facts:\n${facts}`);
            message = (await this.deps.complete(sys, facts)).trim() || facts;
            Logger.info(`proactive: LLM digest → "${message}"`);
        } catch (err) {
            Logger.warn(
                `proactive: digest LLM échoué, repli sur facts bruts — ${err}`,
            );
            message = facts;
        }
        await this.emit(message);
        // Pose le cooldown sur chaque sujet inclus dans le digest, pour que le
        // watcher live ne re-notifie pas le même sujet juste après le flush.
        for (const e of events) this.dedup.record(e.subject, nowMs);
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
    if (cfg.weather) watchers.push(createWeatherWatcher(cfg.weather, deps));
    watchers.push(createPresenceWatcher(deps));
    if (cfg.calendar) watchers.push(createCalendarWatcher(cfg.calendar, deps));
    if (cfg.mail) watchers.push(createMailWatcher(cfg.mail, deps));
    return watchers;
}

export function initProactive(deps: ProactiveDeps): ProactiveEngine {
    const cfg = loadConfig();
    const engine = new ProactiveEngine(cfg, deps);
    engine.setWatchers(buildWatchers(cfg, deps));
    engine.start();
    return engine;
}
