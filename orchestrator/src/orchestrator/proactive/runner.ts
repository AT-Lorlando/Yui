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
import type { IngestOutcome } from './ingest';

export const POLL_TIMEOUT_MS = 60_000;
const FAILURES_BEFORE_SILENCE = 3;
/** Derniers sorts d'ingestion gardés par connecteur (plus récent en tête). */
export const RECENT_MAX = 5;
const STATUS_KEY = '_status';

export interface RecentEvent {
    key: string;
    subject: string;
    at: number;
    outcome: IngestOutcome;
}

export interface ConnectorStatus {
    lastPollAt?: number;
    lastOkAt?: number;
    lastError?: string;
    lastErrorAt?: number;
    failures: number;
    recent: RecentEvent[];
}

export type ConnectorMode =
    | 'poll'
    | 'subscribe'
    | 'poll+subscribe'
    | 'snapshot';

export interface ConnectorStatusView extends ConnectorStatus {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    mode: ConnectorMode;
    pollMinutes?: number;
    nextPollAt?: number;
    polling: boolean;
}

/** Erreurs de `pollNow` — le nom (unique) sert au mapping HTTP de la route. */
export class ConnectorNotFound extends Error {
    constructor(id: string) {
        super(`connecteur inconnu : ${id}`);
        this.name = 'ConnectorNotFound';
    }
}
export class ConnectorNoEvents extends Error {
    constructor(id: string) {
        super(`le connecteur ${id} ne se relève pas (pas de poll)`);
        this.name = 'ConnectorNoEvents';
    }
}
export class ConnectorBusy extends Error {
    constructor(id: string) {
        super(`relève de ${id} déjà en cours`);
        this.name = 'ConnectorBusy';
    }
}

/** Mode d'un connecteur, d'après ce qu'il déclare (cadence effective). */
export function connectorMode(
    def: Pick<ConnectorDef, 'events' | 'pollMinutes' | 'subscribe'>,
): ConnectorMode {
    const polled = !!(def.events && def.pollMinutes);
    if (polled && def.subscribe) return 'poll+subscribe';
    if (polled) return 'poll';
    if (def.subscribe) return 'subscribe';
    return 'snapshot';
}

/** Pousse un sort en tête de `recent`, borné à RECENT_MAX. */
export function pushRecent(recent: RecentEvent[], r: RecentEvent): void {
    recent.unshift(r);
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
}

function emptyCounts(): Record<IngestOutcome, number> {
    return { accepted: 0, expired: 0, deduplicated: 0, held: 0, ignored: 0 };
}

export interface RunnerDeps {
    connectors: ConnectorDef[];
    isEnabled: (id: string) => boolean;
    settings: (def: ConnectorDef) => Record<string, unknown>;
    callTool: ConnectorContext['callTool'];
    presence: () => PresenceState;
    ingest: (e: Event) => Promise<IngestOutcome>;
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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error(`${label} : délai dépassé (${ms} ms)`)),
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
    status: ConnectorStatus;
    timer?: ReturnType<typeof setInterval>;
    /** Prochain tick du timer — une relève manuelle ne le déplace pas. */
    nextTickAt?: number;
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
            // Dernier poll/succès/erreur relus de l'état persisté : la page
            // des connecteurs survit au redémarrage. `failures` et `recent`
            // repartent de zéro (mémoire de process).
            const saved = ctx.state.get<Partial<ConnectorStatus>>(
                STATUS_KEY,
                {},
            );
            const status: ConnectorStatus = { failures: 0, recent: [] };
            for (const k of [
                'lastPollAt',
                'lastOkAt',
                'lastErrorAt',
            ] as const) {
                if (typeof saved[k] === 'number') status[k] = saved[k];
            }
            if (typeof saved.lastError === 'string')
                status.lastError = saved.lastError;
            this.slots.set(def.id, { def, ctx, polling: false, status });
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
                    slot.unsubscribe = def.subscribe(slot.ctx, (e) => {
                        // Contrairement au chemin poll() (ingest() attendu
                        // dans un try/catch), l'émission de subscribe est
                        // fire-and-forget : sans ce .catch(), un ingest() qui
                        // rejette deviendrait une unhandled rejection.
                        this.deps.ingest(e).then(
                            (outcome) => this.record(slot, e, outcome),
                            (err) => {
                                this.log.warn(
                                    `proactive[${def.id}]: ingest — ${err}`,
                                );
                            },
                        );
                    });
                } catch (err) {
                    this.log.warn(
                        `proactive[${def.id}]: subscribe a échoué — ${err}`,
                    );
                }
            }
            if (def.events && def.pollMinutes) {
                const every = def.pollMinutes * 60_000;
                void this.poll(def.id);
                slot.nextTickAt = this.now() + every;
                slot.timer = this.timers.setInterval(() => {
                    slot.nextTickAt = this.now() + every;
                    void this.poll(def.id);
                }, every);
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
            slot.nextTickAt = undefined;
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
        try {
            await this.runPoll(slot);
        } catch {
            /* déjà compté et journalisé par runPoll */
        }
    }

    /** Relève manuelle (bouton de l'app) : mêmes garanties que le tick, mais
     *  les refus sont typés et l'erreur du poll remonte à l'appelant. */
    async pollNow(id: string): Promise<Record<IngestOutcome, number>> {
        const slot = this.slots.get(id);
        if (!slot) throw new ConnectorNotFound(id);
        if (!slot.def.events) throw new ConnectorNoEvents(id);
        if (slot.polling) throw new ConnectorBusy(id);
        return this.runPoll(slot);
    }

    /** Vue de chaque connecteur actif, dans l'ordre de déclaration. */
    status(): ConnectorStatusView[] {
        return [...this.slots.values()].map((slot) => {
            const { def, status } = slot;
            const view: ConnectorStatusView = {
                id: def.id,
                name: def.name,
                description: def.description,
                enabled: true,
                mode: connectorMode(def),
                ...status,
                recent: [...status.recent],
                polling: slot.polling,
            };
            if (def.pollMinutes) view.pollMinutes = def.pollMinutes;
            if (slot.timer && slot.nextTickAt !== undefined)
                view.nextPollAt = slot.nextTickAt;
            return view;
        });
    }

    private record(slot: Slot, e: Event, outcome: IngestOutcome): void {
        pushRecent(slot.status.recent, {
            key: e.key,
            subject: e.subject,
            at: this.now(),
            outcome,
        });
    }

    private persistStatus(slot: Slot): void {
        const { lastPollAt, lastOkAt, lastError, lastErrorAt } = slot.status;
        slot.ctx.state.set(STATUS_KEY, {
            lastPollAt,
            lastOkAt,
            lastError,
            lastErrorAt,
        });
    }

    /** Le poll lui-même — l'appelant a vérifié `events` et le verrou.
     *  Lève après avoir compté et journalisé l'échec. */
    private async runPoll(slot: Slot): Promise<Record<IngestOutcome, number>> {
        const id = slot.def.id;
        const st = slot.status;
        slot.polling = true;
        st.lastPollAt = this.now();
        this.persistStatus(slot);
        try {
            const events = await withTimeout(
                slot.def.events!(slot.ctx),
                this.timeoutMs,
                `poll ${id}`,
            );
            this.log.info(
                `proactive[${id}]: poll → ${events.length} événement(s)`,
            );
            const counts = emptyCounts();
            for (const e of events) {
                const outcome = await this.deps.ingest(e);
                counts[outcome] = (counts[outcome] ?? 0) + 1;
                this.record(slot, e, outcome);
            }
            if (st.failures >= FAILURES_BEFORE_SILENCE)
                this.log.info(`proactive[${id}]: de nouveau OK`);
            st.failures = 0;
            st.lastOkAt = this.now();
            delete st.lastError;
            this.persistStatus(slot);
            return counts;
        } catch (err) {
            st.failures++;
            st.lastError = String(err).slice(0, 200);
            st.lastErrorAt = this.now();
            this.persistStatus(slot);
            // Timeout ou erreur ordinaire : même traitement (spec §5.2).
            // Chaque échec est signalé jusqu'au 3e consécutif inclus (celui-ci
            // avec le suffixe « suspendu »), puis silence — sinon un
            // connecteur qui pend en permanence noierait les logs.
            if (st.failures <= FAILURES_BEFORE_SILENCE) {
                this.log.warn(
                    `proactive[${id}]: ${err}` +
                        (st.failures === FAILURES_BEFORE_SILENCE
                            ? ' — en échec, warnings suspendus jusqu’au prochain succès'
                            : ''),
                );
            }
            throw err;
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
