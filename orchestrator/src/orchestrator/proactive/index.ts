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

            // 1. heures de silence
            if (!critical && isQuietHours(nowDate, this.cfg.quietHours)) {
                this.digest.add(ev);
                return;
            }
            // 2. seuil de bavardage
            if (
                !critical &&
                !passesThreshold(ev.importance, this.cfg.chattiness)
            ) {
                this.digest.add(ev);
                return;
            }
            // 3. anti-répétition
            const cooldown =
                ev.cooldownMs ?? this.cfg.defaultCooldownMin * 60_000;
            if (this.dedup.isDuplicate(ev.subject, nowMs, cooldown)) return;

            // 4 + 6. action whitelist (avec garde anti-conflit)
            if (ev.proposedAction) {
                await this.tryAction(ev.proposedAction, nowMs);
            }

            // 5. formulation (avec le dernier message comme contexte)
            const message = await this.phrase(
                ev,
                this.dedup.lastMessage(ev.subject),
            );
            if (!message) {
                // RIEN : rien de neuf à dire — on ré-arme le cooldown (sans
                // toucher au dernier message) pour ne pas re-consulter le LLM
                // à chaque poll.
                this.dedup.record(ev.subject, nowMs);
                return;
            }

            // 7. sortie
            await this.emit(message);

            // 8. trace
            this.dedup.record(ev.subject, nowMs, message);
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
        if (ev.template) return ev.template;
        try {
            const sys = this.cfg.prompts?.phrase ?? DEFAULT_PHRASE_PROMPT;
            const user =
                lastMessage && lastMessage.length > 0
                    ? `Déjà signalé récemment : "${lastMessage}". Situation actuelle : ${ev.facts}`
                    : ev.facts;
            const out = (await this.deps.complete(sys, user)).trim();
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
        await this.deps.notify(text);
        if (this.deps.presenceState() === 'home') {
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
        Logger.info(`proactive: démarré (${this.watchers.length} watchers)`);
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
        const facts = events.map((e) => `- ${e.facts}`).join('\n');
        let message: string;
        try {
            const sys = this.cfg.prompts?.digest ?? DEFAULT_DIGEST_PROMPT;
            message = (await this.deps.complete(sys, facts)).trim() || facts;
        } catch {
            message = facts;
        }
        await this.emit(message);
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
