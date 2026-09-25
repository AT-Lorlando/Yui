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

/** Plafond des `urgent` : ils ignorent le quota horaire de leur source, mais
 *  pas indéfiniment — une app authentifiée pourrait sinon noyer le foyer en
 *  marquant tout `urgent` avec des clés tournantes (la dédup ne mord pas). Seul
 *  `critique`, réservé aux vraies urgences, reste sans plafond. */
export const URGENT_RATE_MULTIPLIER = 3;

export type IngestOutcome =
    | 'accepted'
    | 'expired'
    | 'deduplicated'
    | 'held'
    | 'ignored';

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
    /** Une source (brique `external:<source>` ou connecteur) est-elle
     *  active ? Optionnel — défaut « toujours active » pour ne pas casser les
     *  appelants qui ne connaissent pas les briques externes. */
    isSourceEnabled?: (source: string) => boolean;
    /** Signalée une seule fois par source et par process — permet au moteur
     *  de faire apparaître une brique `external:<source>` dès le premier
     *  événement reçu. */
    onNewSource?: (source: string) => void;
}

export class Ingest {
    /** Sources déjà vues par CETTE instance — `onNewSource` n'est appelé
     *  qu'à la première ingestion de chacune. */
    private known = new Set<string>();

    constructor(private deps: IngestDeps) {}

    async ingest(e: Event): Promise<IngestOutcome> {
        if (!this.known.has(e.source)) {
            this.known.add(e.source);
            this.deps.onNewSource?.(e.source);
        }
        if (!(this.deps.isSourceEnabled?.(e.source) ?? true)) {
            return 'ignored';
        }

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

        if (!critical) {
            const base = this.deps.maxPerHour(e.source);
            const max = urgent ? base * URGENT_RATE_MULTIPLIER : base;
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
            ignored: 0,
        };
        for (const e of events) counts[await this.ingest(e)]++;
        return counts;
    }
}
