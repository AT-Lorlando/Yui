import Logger from '../../logger';
import { isQuietHours, passesThreshold } from './gates';
import { Dedup } from './dedup';
import { DigestBuffer } from './digest';
import { isActionBlocked } from './guard';
import { loadHistory } from '../history';
import { loadAutomations } from '../automations';
import type {
    CandidateEvent,
    ProactiveConfig,
    ProactiveDeps,
    Watcher,
} from './types';

export class ProactiveEngine {
    private dedup = new Dedup();
    private digest: DigestBuffer;
    private watchers: Watcher[] = [];
    private now: () => number;

    constructor(
        private cfg: ProactiveConfig,
        private deps: ProactiveDeps,
        digest?: DigestBuffer,
    ) {
        this.now = deps.now ?? (() => Date.now());
        this.digest = digest ?? new DigestBuffer();
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

            // 5. formulation
            const message = await this.phrase(ev);
            if (!message) return;

            // 7. sortie
            await this.emit(message);

            // 8. trace
            this.dedup.record(ev.subject, nowMs);
        } catch (err) {
            Logger.error(
                `proactive: processCandidate "${ev.subject}" — ${err}`,
            );
        }
    }

    private async phrase(ev: CandidateEvent): Promise<string | null> {
        if (ev.template) return ev.template;
        try {
            const sys =
                "Tu es Yui, l'assistante de Jérémy. Reformule ce fait en une phrase orale courte et naturelle, en français, sans aucun markdown. Si ce n'est pas digne d'être signalé, réponds exactement RIEN.";
            const out = (await this.deps.complete(sys, ev.facts)).trim();
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
