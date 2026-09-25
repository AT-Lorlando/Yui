// Planificateur des connecteurs (spec §5.1-5.2, 5.5). Remplace les timers
// éparpillés des anciens watchers : un intervalle par connecteur actif,
// polls SÉRIALISÉS (un tick pendant un poll en cours est sauté) et BORNÉS
// (timeout), erreurs journalisées sans arrêter le connecteur, et un seul
// warning après trois échecs consécutifs. `subscribe` est branché au start
// et débranché au stop.
import Logger from '../../logger';
import type { PresenceState } from '../presence';
import type { ConnectorContext, ConnectorDef } from './connector';
import { ConnectorState, connectorStateFile } from './connectorState';
import type { Event, Fact } from './events';

export const POLL_TIMEOUT_MS = 60_000;
const FAILURES_BEFORE_SILENCE = 3;

export interface RunnerDeps {
    connectors: ConnectorDef[];
    isEnabled: (id: string) => boolean;
    settings: (def: ConnectorDef) => Record<string, unknown>;
    callTool: ConnectorContext['callTool'];
    presence: () => PresenceState;
    ingest: (e: Event) => Promise<unknown>;
    now?: () => number;
    /** undefined = état en mémoire (tests). */
    stateFile?: (id: string) => string | undefined;
    timers?: {
        setInterval: typeof setInterval;
        clearInterval: typeof clearInterval;
    };
    pollTimeoutMs?: number;
    log?: { info(m: string): void; warn(m: string): void };
}

/** Distingue un dépassement de délai d'une erreur ordinaire du connecteur
 *  (cf. poll() : un timeout est toujours signalé, une erreur ordinaire est
 *  soumise au throttle des 3 échecs). */
class PollTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(
            () =>
                reject(
                    new PollTimeoutError(`${label} : délai dépassé (${ms} ms)`),
                ),
            ms,
        );
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}

interface Slot {
    def: ConnectorDef;
    ctx: ConnectorContext;
    polling: boolean;
    failures: number;
    timer?: ReturnType<typeof setInterval>;
    unsubscribe?: () => void;
}

export class ConnectorRunner {
    private slots = new Map<string, Slot>();
    private now: () => number;
    private timers: NonNullable<RunnerDeps['timers']>;
    private timeoutMs: number;
    private log: NonNullable<RunnerDeps['log']>;

    constructor(private deps: RunnerDeps) {
        this.now = deps.now ?? (() => Date.now());
        this.timers = deps.timers ?? { setInterval, clearInterval };
        this.timeoutMs = deps.pollTimeoutMs ?? POLL_TIMEOUT_MS;
        this.log = deps.log ?? Logger;
        for (const def of deps.connectors) {
            if (!deps.isEnabled(def.id)) continue;
            const file = deps.stateFile
                ? deps.stateFile(def.id)
                : connectorStateFile(def.id);
            const ctx: ConnectorContext = {
                callTool: deps.callTool,
                settings: deps.settings(def),
                state: new ConnectorState(file),
                presence: deps.presence,
                now: this.now,
                log: {
                    info: (m) => this.log.info(`proactive[${def.id}]: ${m}`),
                    warn: (m) => this.log.warn(`proactive[${def.id}]: ${m}`),
                },
            };
            this.slots.set(def.id, { def, ctx, polling: false, failures: 0 });
        }
    }

    activeIds(): string[] {
        return [...this.slots.keys()];
    }

    start(): void {
        for (const slot of this.slots.values()) {
            const { def } = slot;
            if (def.subscribe) {
                try {
                    slot.unsubscribe = def.subscribe(
                        slot.ctx,
                        (e) => void this.deps.ingest(e),
                    );
                } catch (err) {
                    this.log.warn(
                        `proactive[${def.id}]: subscribe a échoué — ${err}`,
                    );
                }
            }
            if (def.events && def.pollMinutes) {
                void this.poll(def.id);
                slot.timer = this.timers.setInterval(
                    () => void this.poll(def.id),
                    def.pollMinutes * 60_000,
                );
            }
        }
        this.log.info(
            `proactive: connecteurs actifs [${this.activeIds().join(', ')}]`,
        );
    }

    stop(): void {
        for (const slot of this.slots.values()) {
            if (slot.timer) this.timers.clearInterval(slot.timer);
            slot.timer = undefined;
            try {
                slot.unsubscribe?.();
            } catch {
                /* best-effort */
            }
            slot.unsubscribe = undefined;
        }
    }

    /** Un poll : sérialisé (skip si en cours), borné, erreurs comptées. */
    async poll(id: string): Promise<void> {
        const slot = this.slots.get(id);
        if (!slot?.def.events) return;
        if (slot.polling) {
            this.log.info(
                `proactive[${id}]: poll précédent en cours — tick sauté`,
            );
            return;
        }
        slot.polling = true;
        try {
            const events = await withTimeout(
                slot.def.events(slot.ctx),
                this.timeoutMs,
                `poll ${id}`,
            );
            if (slot.failures >= FAILURES_BEFORE_SILENCE)
                this.log.info(`proactive[${id}]: de nouveau OK`);
            slot.failures = 0;
            this.log.info(
                `proactive[${id}]: poll → ${events.length} événement(s)`,
            );
            for (const e of events) await this.deps.ingest(e);
        } catch (err) {
            slot.failures++;
            // Un timeout est toujours signalé (délai anormal, utile à chaque
            // occurrence). Une erreur ordinaire est soumise au throttle : un
            // seul warning, exactement au 3e échec consécutif — pas un par
            // échec (sinon 3 warnings pour la même série avant le silence).
            if (err instanceof PollTimeoutError) {
                this.log.warn(`proactive[${id}]: ${err}`);
            } else if (slot.failures === FAILURES_BEFORE_SILENCE) {
                this.log.warn(
                    `proactive[${id}]: ${err} — en échec, warnings suspendus jusqu’au prochain succès`,
                );
            }
        } finally {
            slot.polling = false;
        }
    }

    /** État courant de chaque connecteur actif (une section par connecteur). */
    async snapshots(): Promise<Record<string, Fact[]>> {
        const out: Record<string, Fact[]> = {};
        await Promise.all(
            [...this.slots.values()]
                .filter((s) => s.def.snapshot)
                .map(async (s) => {
                    try {
                        out[s.def.id] = await withTimeout(
                            s.def.snapshot!(s.ctx),
                            this.timeoutMs,
                            `snapshot ${s.def.id}`,
                        );
                    } catch (err) {
                        this.log.warn(
                            `proactive[${s.def.id}]: snapshot — ${err}`,
                        );
                    }
                }),
        );
        return out;
    }
}
