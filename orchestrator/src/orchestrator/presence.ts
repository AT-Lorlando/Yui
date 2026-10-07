/**
 * Presence detection — knows if the user is home or away.
 *
 * Geofence-authoritative: state is driven by native Android geofence events
 * (enter/exit) pushed via POST /presence/geofence.
 *
 * On arrival, a MAC burst is armed: the Mikrotik ARP table is polled at short
 * intervals to detect when the phone joins the network (network-join event).
 */

import Logger from '../logger';
import { createMacBurst, type MacBurst } from './macBurst';
import {
    loadPresenceConfig,
    type DepartureConfirmConfig,
} from './presenceConfig';
import { confirmDeparture, pingHost } from './departureGuard';
import { logActivity } from './activityLog';

// ── Env ───────────────────────────────────────────────────────────────────────

const HOME_LAT = parseFloat(process.env.HOME_LAT ?? '0');
const HOME_LNG = parseFloat(process.env.HOME_LNG ?? '0');
const PHONE_MAC = (process.env.PHONE_MAC ?? '').toLowerCase().trim();
const PHONE_IP = (process.env.PHONE_IP ?? '').trim(); // optional fixed IP for precise ARP check
const MIKROTIK_IP = process.env.MIKROTIK_IP ?? '10.0.0.1';
const MIKROTIK_USER = process.env.MIKROTIK_USER ?? 'api-ro';
const MIKROTIK_PASS = process.env.MIKROTIK_PASS ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PresenceState = 'home' | 'away' | 'unknown';

export type PresenceEventType = 'arrival' | 'departure' | 'network-join';

// ── Pure functions ─────────────────────────────────────────────────────────────

/** Pure : transition d'état geofence (dé-dupliquée) + event émis. */
export function geofenceTransition(
    state: PresenceState,
    transition: string,
): { next: PresenceState; event: PresenceEventType | null } {
    if (transition === 'enter' && state !== 'home')
        return { next: 'home', event: 'arrival' };
    if (transition === 'exit' && state !== 'away')
        return { next: 'away', event: 'departure' };
    return { next: state, event: null };
}

/** Coords du domicile (depuis .env) — exposées pour l'endpoint /presence/config. */
export function getHomeCoords(): { lat: number; lng: number } {
    return { lat: HOME_LAT, lng: HOME_LNG };
}

// ── Mikrotik REST API ─────────────────────────────────────────────────────────

/**
 * Parses Mikrotik duration strings like "23m1s", "1h2m3s", "45s" → milliseconds.
 */
export function parseMikrotikDuration(s: string): number {
    let ms = 0;
    const d = s.match(/(\d+)d/);
    if (d) ms += parseInt(d[1]) * 86_400_000;
    const h = s.match(/(\d+)h/);
    if (h) ms += parseInt(h[1]) * 3_600_000;
    const m = s.match(/(\d+)m/);
    if (m) ms += parseInt(m[1]) * 60_000;
    const sec = s.match(/(\d+)s/);
    if (sec) ms += parseInt(sec[1]) * 1_000;
    return ms;
}

/** Signal qui a conclu « présent » : ARP temps réel ou bail DHCP frais. */
export type PresenceSignal = 'arp' | 'dhcp';

export interface NetworkCheckResult {
    /** true = phone seen, false = phone absent, null = router unreachable */
    present: boolean | null;
    /** Signal gagnant quand `present` (pour le journal de la garde). */
    signal?: PresenceSignal | null;
    /** Résumé lisible `ARP=… DHCP=…/last-seen=…` (journal). */
    detail?: string;
}

export interface MikrotikEntry {
    'mac-address'?: string;
    status?: string;
    'last-seen'?: string;
}

/**
 * Pure : décide si le téléphone est présent à partir des entrées ARP + bail DHCP.
 *
 * - ARP `reachable` = vérité temps réel (le tél. répond maintenant).
 * - DHCP `bound` + `last-seen` récent = présence lissée (survit au WiFi
 *   power-save qui fait passer l'ARP en `stale`/`failed` toutes les ~2 min).
 *
 * ⚠️ Un bail `bound` SEUL ne suffit pas : il persiste jusqu'à expiration bien
 * après le départ du téléphone (d'où le faux positif "toujours home"). On exige
 * donc un `last-seen` dans la fenêtre `dhcpFreshnessMs`.
 */
export function evaluateNetworkPresence(args: NetworkPresenceArgs): boolean {
    return networkPresenceSignals(args).present;
}

export interface NetworkPresenceArgs {
    phoneMac: string;
    arp?: MikrotikEntry | null;
    lease?: MikrotikEntry | null;
    /**
     * Fenêtre de fraîcheur du bail. 15 min pour le seed au boot et le burst
     * d'arrivée ; pendant la garde de départ c'est `now - exitAt` — seul un
     * bail vu APRÈS l'exit prouve que le téléphone est encore là.
     */
    dhcpFreshnessMs: number;
}

/**
 * Pure : même règle que `evaluateNetworkPresence`, mais dit QUEL signal a
 * conclu (ARP d'abord, puis DHCP) et l'âge du bail — pour le journal.
 */
export function networkPresenceSignals(args: NetworkPresenceArgs): {
    present: boolean;
    signal: PresenceSignal | null;
    lastSeenMs: number | null;
} {
    const mac = args.phoneMac.toLowerCase();
    const macMatches = (e?: MikrotikEntry | null): boolean =>
        e?.['mac-address']?.toLowerCase() === mac;

    const arpReachable =
        macMatches(args.arp) && args.arp?.status === 'reachable';

    const lastSeen = args.lease?.['last-seen'];
    const lastSeenMs =
        typeof lastSeen === 'string' ? parseMikrotikDuration(lastSeen) : null;
    const dhcpFresh =
        macMatches(args.lease) &&
        args.lease?.status === 'bound' &&
        lastSeenMs !== null &&
        lastSeenMs <= args.dhcpFreshnessMs;

    const signal: PresenceSignal | null = arpReachable
        ? 'arp'
        : dhcpFresh
        ? 'dhcp'
        : null;
    return { present: signal !== null, signal, lastSeenMs };
}

/**
 * Check if the phone is on the network via Mikrotik DHCP + ARP.
 *
 * When PHONE_IP is set (fixed IP):
 *   - Queries DHCP lease for stable `last-seen` timestamp (survives WiFi sleep)
 *   - Queries ARP for real-time `reachable` status
 *   - present = true if DHCP lease is bound OR ARP is reachable
 *
 * Using DHCP last-seen prevents the noisy "absent 2min / found / absent 2min" log
 * pattern caused by Android WiFi power-saving waking the radio briefly.
 */
export async function checkPhoneOnNetwork(
    dhcpFreshnessMs = 900_000,
): Promise<NetworkCheckResult> {
    const auth = Buffer.from(`${MIKROTIK_USER}:${MIKROTIK_PASS}`).toString(
        'base64',
    );
    const headers = { Authorization: `Basic ${auth}` };
    const fail: NetworkCheckResult = { present: null };

    try {
        if (PHONE_IP) {
            const [dhcpRes, arpRes] = await Promise.all([
                fetch(
                    `http://${MIKROTIK_IP}/rest/ip/dhcp-server/lease?address=${PHONE_IP}`,
                    {
                        headers,
                        signal: AbortSignal.timeout(5_000),
                    },
                ),
                fetch(`http://${MIKROTIK_IP}/rest/ip/arp?address=${PHONE_IP}`, {
                    headers,
                    signal: AbortSignal.timeout(5_000),
                }),
            ]);

            if (!dhcpRes.ok && !arpRes.ok) {
                Logger.warn(
                    `[presence] Mikrotik error: DHCP=${dhcpRes.status} ARP=${arpRes.status}`,
                );
                return fail;
            }

            const lease: MikrotikEntry | null = dhcpRes.ok
                ? ((await dhcpRes.json()) as MikrotikEntry[])[0] ?? null
                : null;
            const arp: MikrotikEntry | null = arpRes.ok
                ? ((await arpRes.json()) as MikrotikEntry[])[0] ?? null
                : null;

            const { present, signal } = networkPresenceSignals({
                phoneMac: PHONE_MAC,
                arp,
                lease,
                dhcpFreshnessMs,
            });

            const detail = `ARP=${arp?.status ?? 'none'} DHCP=${
                lease?.status ?? 'none'
            }/last-seen=${lease?.['last-seen'] ?? '-'}`;
            Logger.debug(
                `[presence] ${detail} (seuil DHCP ${Math.round(
                    dhcpFreshnessMs / 1000,
                )}s) → ${present ? 'present' : 'absent'}`,
            );
            return { present, signal, detail };
        } else {
            // Fallback: full ARP table scan
            const res = await fetch(`http://${MIKROTIK_IP}/rest/ip/arp`, {
                headers,
                signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) {
                Logger.warn(
                    `[presence] Mikrotik ARP API returned ${res.status}`,
                );
                return fail;
            }
            const entries: { 'mac-address'?: string; status?: string }[] =
                await res.json();
            const found = entries.some(
                (e) =>
                    e['mac-address']?.toLowerCase() === PHONE_MAC &&
                    e.status === 'reachable',
            );
            return {
                present: found,
                signal: found ? 'arp' : null,
                detail: `ARP=${found ? 'reachable' : 'absent'}`,
            };
        }
    } catch (e) {
        Logger.warn(`[presence] Mikrotik unreachable — ${e}`);
        return fail;
    }
}

// ── PresenceManager ───────────────────────────────────────────────────────────

export class PresenceManager {
    private state: PresenceState = 'unknown';
    /**
     * Plusieurs abonnés, pas un seul : le moment « retour » de la proactivité et
     * le connecteur `presence` s'abonnent tous les deux, et un slot unique
     * écrasait silencieusement le premier inscrit.
     */
    private _onChange: ((p: PresenceState, n: PresenceState) => void)[] = [];
    private _onEvent: ((e: PresenceEventType) => void) | null = null;
    private burst: MacBurst | null = null;

    /** Retourne le désabonnement (à appeler pour ne plus rien recevoir). */
    onChange(cb: (p: PresenceState, n: PresenceState) => void): () => void {
        this._onChange.push(cb);
        return () => {
            this._onChange = this._onChange.filter((f) => f !== cb);
        };
    }

    onEvent(cb: (e: PresenceEventType) => void): void {
        this._onEvent = cb;
    }

    getState(): PresenceState {
        return this.state;
    }

    private setState(next: PresenceState): void {
        const prev = this.state;
        if (prev === next) return;
        this.state = next;
        // Chaque abonné dans son propre try : un listener qui lève ne doit pas
        // priver les suivants de la transition.
        for (const cb of [...this._onChange]) {
            try {
                cb(prev, next);
            } catch (e) {
                Logger.warn(`presence onChange failed: ${e}`);
            }
        }
    }

    private emit(event: PresenceEventType): void {
        if (this._onEvent) {
            try {
                this._onEvent(event);
            } catch (e) {
                Logger.warn(`presence onEvent failed: ${e}`);
            }
        }
    }

    /**
     * Jeton de la confirmation de départ en cours. Incrémenté pour annuler :
     * un ENTER (ou un nouveau EXIT) invalide la fenêtre précédente.
     */
    private departureToken = 0;
    private departurePending = false;

    /** POST /presence/geofence : enter|exit pilotent l'état + events. */
    handleGeofence(transition: string): PresenceState {
        // Tout ENTER annule une confirmation de départ en cours : le geofence
        // s'est ravisé, on n'a jamais quitté la maison.
        if (transition === 'enter' && this.departurePending) {
            this.departureToken++;
            this.departurePending = false;
            Logger.info(
                '[presence] pending departure cancelled by geofence enter',
            );
        }

        const { next, event } = geofenceTransition(this.state, transition);
        if (event === 'departure') {
            // Un EXIT ne vaut plus départ : le geofence Android émet des EXIT
            // fantômes en sommeil profond (faux départ nocturne du 17/08,
            // scène Good bye à 01h18, puis état bloqué away 2 jours). On
            // vérifie d'abord que le téléphone a vraiment quitté le réseau.
            this.startDepartureConfirmation();
            return this.state;
        }
        if (event) {
            Logger.info(
                `[presence] geofence ${transition} → ${next} (event=${event})`,
            );
            this.setState(next);
            if (event === 'arrival') {
                this.armBurst();
                logActivity('presence', 'Arrivée', 'enter geofence');
            }
            this.emit(event);
        } else {
            Logger.debug(
                `[presence] geofence ${transition} ignored (state=${this.state})`,
            );
        }
        return this.state;
    }

    private startDepartureConfirmation(): void {
        if (this.departurePending) {
            Logger.debug('[presence] departure already pending — exit ignored');
            return;
        }
        const cfg = this.departureConfig();
        const token = ++this.departureToken;
        this.departurePending = true;
        // Instant de l'exit : la fraîcheur DHCP exigée pendant la garde est
        // mesurée depuis ici (cf. en-tête de departureGuard.ts).
        const exitAt = this.now();
        let checkNo = 0;
        let vetoReason = '';
        Logger.info(
            `[presence] geofence exit → confirmation réseau (${
                cfg.checks
            } vérif(s), fenêtre ~${Math.round(
                (cfg.delayMs + cfg.checks * cfg.intervalMs) / 1000,
            )}s)`,
        );
        void confirmDeparture({
            delayMs: cfg.delayMs,
            checks: cfg.checks,
            intervalMs: cfg.intervalMs,
            isPhoneHome: async () => {
                checkNo++;
                // Bornée ≥ 0 : une horloge qui recule ne doit pas donner
                // une fenêtre négative (= jamais frais) ni immense.
                const sinceExitMs = Math.max(0, this.now() - exitAt);
                // Sonde d'abord (réveille l'ARP d'un téléphone endormi),
                // best-effort : un échec ne change rien au verdict réseau.
                let pinged = false;
                try {
                    pinged = await this.probePhone();
                } catch (e) {
                    Logger.debug(`[presence] sonde ping KO: ${e}`);
                }
                const r = await this.checkNetwork(sinceExitMs);
                if (r.present === true) {
                    const why =
                        r.signal === 'dhcp'
                            ? `bail DHCP vu après l'exit (seuil ${Math.round(
                                  sinceExitMs / 1000,
                              )}s depuis l'exit)`
                            : `ARP reachable (ping ${
                                  pinged ? 'répond' : 'muet'
                              })`;
                    vetoReason = `vérif ${checkNo}/${cfg.checks} : ${why}${
                        r.detail ? ` — ${r.detail}` : ''
                    }`;
                }
                return r.present;
            },
            isCancelled: () => token !== this.departureToken,
        }).then((verdict) => {
            if (token !== this.departureToken) return;
            this.departurePending = false;
            if (verdict === 'vetoed') {
                Logger.info(
                    `[presence] départ ANNULÉ — téléphone encore sur le réseau, ${vetoReason}`,
                );
                logActivity(
                    'presence',
                    'Départ annulé',
                    `exit geofence reçu mais téléphone vu sur le réseau (${vetoReason})`,
                );
                return;
            }
            if (verdict === 'confirmed') {
                Logger.info('[presence] departure confirmed by network check');
                logActivity(
                    'presence',
                    'Départ confirmé',
                    'téléphone absent du réseau pendant la fenêtre de vérification',
                );
                this.setState('away');
                this.burst?.cancel();
                this.emit('departure');
            }
        });
    }

    /**
     * Injectable pour les tests. `dhcpFreshnessMs` par défaut = 15 min
     * (seed / burst) ; la garde de départ passe le temps écoulé depuis l'exit.
     */
    protected checkNetwork(
        dhcpFreshnessMs?: number,
    ): Promise<NetworkCheckResult> {
        return checkPhoneOnNetwork(dhcpFreshnessMs);
    }

    /** Injectable pour les tests : ping du téléphone (`PHONE_IP`), best-effort. */
    protected probePhone(): Promise<boolean> {
        return pingHost(PHONE_IP);
    }

    /** Injectable pour les tests (horloge simulée). */
    protected now(): number {
        return Date.now();
    }

    /** Injectable pour les tests (la vraie config a 60 s de délai). */
    protected departureConfig(): DepartureConfirmConfig {
        return loadPresenceConfig().departureConfirm;
    }

    private armBurst(): void {
        this.burst?.cancel();
        const cfg = loadPresenceConfig();
        this.burst = createMacBurst({
            intervalMs: cfg.mac.burstIntervalMs,
            windowMs: cfg.mac.burstWindowMs,
            poll: async () => (await checkPhoneOnNetwork()).present,
            onJoin: () => this.emit('network-join'),
        });
        this.burst.start();
    }

    start(): void {
        Logger.info('[presence] manager started (geofence-authoritative)');
        void this.seedState();
    }

    /**
     * Détermine l'état courant UNE fois au démarrage via le réseau (le geofence
     * est edge-triggered et ne donne pas l'état initial). N'émet pas d'event de
     * règle : seed purement informatif, les transitions restent pilotées par le
     * geofence / le poll.
     */
    private async seedState(): Promise<void> {
        const { present } = await checkPhoneOnNetwork();
        if (present === null) {
            Logger.info(
                '[presence] startup seed skipped (router unreachable) — state=unknown',
            );
            return;
        }
        const next: PresenceState = present ? 'home' : 'away';
        Logger.info(`[presence] startup seed → state=${next}`);
        this.setState(next);
    }

    stop(): void {
        this.burst?.cancel();
    }
}
