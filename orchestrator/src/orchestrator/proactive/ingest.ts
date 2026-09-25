// La porte d'entrée unique du bus (spec §5.3). Tout événement — poll d'un
// connecteur, `subscribe`, `POST /events` — passe ici, et les filtres vont
// du moins cher au plus cher : péremption, dédup, heures de silence,
// cooldown par source… le juge LLM ne voit que ce qui a survécu. C'est la
// barrière anti-flood : elle ne dépend d'aucune IA.
import Logger from '../../logger';
import { eventKey, factsFingerprint, isExpired } from './events';
import type { Event } from './events';
import { isQuietHours } from './gates';
import type { Dedup } from './dedup';
import type { HeldQueue } from './held';
import type { RateWindow } from './rate';

export type IngestOutcome = 'accepted' | 'expired' | 'deduplicated' | 'held';

export interface IngestDeps {
    dedup: Dedup;
    held: HeldQueue;
    rate: RateWindow;
    now: () => number;
    defaultCooldownMs: () => number;
    maxPerHour: (source: string) => number;
    quietHours: () => { start: string; end: string };
    /** Le consommateur final (le juge + sortie). Appelé seulement si accepté. */
    judge: (e: Event) => Promise<void>;
}

export class Ingest {
    constructor(private deps: IngestDeps) {}

    async ingest(e: Event): Promise<IngestOutcome> {
        const now = this.deps.now();
        const key = eventKey(e);
        const critical = e.importance === 'critique';
        const urgent = critical || e.importance === 'urgent';

        if (isExpired(e, now)) {
            Logger.info(`proactive: ⊘ périmé ${key}`);
            return 'expired';
        }

        const fp = factsFingerprint(e);
        const cooldown = e.cooldownMs ?? this.deps.defaultCooldownMs();
        if (!critical && this.deps.dedup.isDuplicate(key, now, cooldown, fp)) {
            Logger.info(
                `proactive: ⊘ doublon ${key} (cooldown ${Math.round(
                    cooldown / 60_000,
                )} min)`,
            );
            return 'deduplicated';
        }

        if (!urgent && isQuietHours(new Date(now), this.deps.quietHours())) {
            return this.hold(e, now, fp, 'heures de silence');
        }

        if (!urgent) {
            const max = this.deps.maxPerHour(e.source);
            if (this.deps.rate.count(e.source, now) >= max) {
                return this.hold(e, now, fp, `cooldown de source (${max}/h)`);
            }
        }
        this.deps.rate.hit(e.source, now);

        try {
            await this.deps.judge(e);
        } catch (err) {
            Logger.error(`proactive: juge en erreur pour ${key} — ${err}`);
        }
        return 'accepted';
    }

    private hold(
        e: Event,
        now: number,
        fp: string,
        why: string,
    ): IngestOutcome {
        Logger.info(`proactive: ⏸ retenu ${eventKey(e)} (${why})`);
        this.deps.held.add(e, now);
        this.deps.dedup.record(eventKey(e), now, undefined, fp);
        return 'held';
    }

    async ingestAll(events: Event[]): Promise<Record<IngestOutcome, number>> {
        const counts: Record<IngestOutcome, number> = {
            accepted: 0,
            expired: 0,
            deduplicated: 0,
            held: 0,
        };
        for (const e of events) counts[await this.ingest(e)]++;
        return counts;
    }
}
