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
import { loadPresenceConfig } from './presenceConfig';

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

interface NetworkCheckResult {
    /** true = phone seen, false = phone absent, null = router unreachable */
    present: boolean | null;
}

interface MikrotikEntry {
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
export function evaluateNetworkPresence(args: {
    phoneMac: string;
    arp?: MikrotikEntry | null;
    lease?: MikrotikEntry | null;
    dhcpFreshnessMs: number;
}): boolean {
    const mac = args.phoneMac.toLowerCase();
    const macMatches = (e?: MikrotikEntry | null): boolean =>
        e?.['mac-address']?.toLowerCase() === mac;

    const arpReachable =
        macMatches(args.arp) && args.arp?.status === 'reachable';

    const lastSeen = args.lease?.['last-seen'];
    const dhcpFresh =
        macMatches(args.lease) &&
        args.lease?.status === 'bound' &&
        typeof lastSeen === 'string' &&
        parseMikrotikDuration(lastSeen) <= args.dhcpFreshnessMs;

    return arpReachable || dhcpFresh;
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

            const present = evaluateNetworkPresence({
                phoneMac: PHONE_MAC,
                arp,
                lease,
                dhcpFreshnessMs,
            });

            Logger.debug(
                `[presence] ARP=${arp?.status ?? 'none'} DHCP=${
                    lease?.status ?? 'none'
                }/last-seen=${lease?.['last-seen'] ?? '-'} → ${
                    present ? 'present' : 'absent'
                }`,
            );
            return { present };
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
            return { present: found };
        }
    } catch (e) {
        Logger.warn(`[presence] Mikrotik unreachable — ${e}`);
        return fail;
    }
}

// ── PresenceManager ───────────────────────────────────────────────────────────

export class PresenceManager {
    private state: PresenceState = 'unknown';
    private _onChange: ((p: PresenceState, n: PresenceState) => void) | null =
        null;
    private _onEvent: ((e: PresenceEventType) => void) | null = null;
    private burst: MacBurst | null = null;
    private pollTimer: NodeJS.Timeout | null = null;

    onChange(cb: (p: PresenceState, n: PresenceState) => void): void {
        this._onChange = cb;
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
        if (this._onChange) {
            try {
                this._onChange(prev, next);
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

    /** POST /presence/geofence : enter|exit pilotent l'état + events. */
    handleGeofence(transition: string): PresenceState {
        const { next, event } = geofenceTransition(this.state, transition);
        if (event) {
            Logger.info(
                `[presence] geofence ${transition} → ${next} (event=${event})`,
            );
            this.setState(next);
            if (event === 'arrival') this.armBurst();
            if (event === 'departure') this.burst?.cancel();
            this.emit(event);
        } else {
            Logger.debug(
                `[presence] geofence ${transition} ignored (state=${this.state})`,
            );
        }
        return this.state;
    }

    private armBurst(): void {
        this.burst?.cancel();
        const cfg = loadPresenceConfig();
        this.burst = createMacBurst({
            intervalMs: cfg.mac.burstIntervalMs,
            windowMs: cfg.mac.burstWindowMs,
            poll: async () =>
                (await checkPhoneOnNetwork(cfg.net.dhcpFreshnessMs)).present,
            onJoin: () => this.emit('network-join'),
        });
        this.burst.start();
    }

    start(): void {
        Logger.info(
            '[presence] manager started (geofence + network safety-net poll)',
        );
        void this.seedState();
        this.startPoll();
    }

    /**
     * Détermine l'état courant UNE fois au démarrage via le réseau (le geofence
     * est edge-triggered et ne donne pas l'état initial). N'émet pas d'event de
     * règle : seed purement informatif, les transitions restent pilotées par le
     * geofence / le poll.
     */
    private async seedState(): Promise<void> {
        const { net } = loadPresenceConfig();
        const { present } = await checkPhoneOnNetwork(net.dhcpFreshnessMs);
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

    private startPoll(): void {
        const { net } = loadPresenceConfig();
        this.pollTimer = setInterval(
            () => void this.pollNetwork(),
            net.pollIntervalMs,
        );
        if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    }

    /**
     * Filet de sécurité réseau : si le geofence rate un event (ex : l'app
     * Android ne délivre pas l'`exit`), le poll corrige l'état tout seul. Émet
     * arrival/departure pour que les règles de présence + la proactivité
     * réagissent comme à un event geofence.
     */
    private async pollNetwork(): Promise<void> {
        const { net } = loadPresenceConfig();
        const { present } = await checkPhoneOnNetwork(net.dhcpFreshnessMs);
        if (present === null) return; // routeur injoignable → on garde l'état
        const next: PresenceState = present ? 'home' : 'away';
        if (next === this.state) return;
        const event: PresenceEventType =
            next === 'home' ? 'arrival' : 'departure';
        Logger.info(
            `[presence] network poll → ${next} (was ${this.state}, event=${event})`,
        );
        this.setState(next);
        if (event === 'departure') this.burst?.cancel();
        this.emit(event);
    }

    stop(): void {
        this.burst?.cancel();
        if (this.pollTimer) clearInterval(this.pollTimer);
    }
}
