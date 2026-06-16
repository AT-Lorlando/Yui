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
export async function checkPhoneOnNetwork(): Promise<NetworkCheckResult> {
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

            // DHCP: phone is associated to the network (survives WiFi power-save sleep)
            let dhcpBound = false;
            if (dhcpRes.ok) {
                const leases: { 'mac-address'?: string; status?: string }[] =
                    await dhcpRes.json();
                const lease = leases[0];
                dhcpBound =
                    lease?.['mac-address']?.toLowerCase() === PHONE_MAC &&
                    lease?.status === 'bound';
            }

            // ARP: real-time reachability (true only when phone is awake/responding)
            let arpReachable = false;
            if (arpRes.ok) {
                const entries: { 'mac-address'?: string; status?: string }[] =
                    await arpRes.json();
                const entry = entries[0];
                arpReachable =
                    entry?.['mac-address']?.toLowerCase() === PHONE_MAC &&
                    entry?.status === 'reachable';
            }

            // present = DHCP bound OR ARP reachable
            const present = dhcpBound || arpReachable;

            Logger.debug(
                `[presence] DHCP=${dhcpBound ? 'bound' : 'absent'} ARP=${
                    arpReachable ? 'reachable' : 'stale'
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
        const cfg = loadPresenceConfig().mac;
        this.burst = createMacBurst({
            intervalMs: cfg.burstIntervalMs,
            windowMs: cfg.burstWindowMs,
            poll: async () => (await checkPhoneOnNetwork()).present,
            onJoin: () => this.emit('network-join'),
        });
        this.burst.start();
    }

    start(): void {
        Logger.info('[presence] manager started (geofence-authoritative)');
    }

    stop(): void {
        this.burst?.cancel();
    }
}
