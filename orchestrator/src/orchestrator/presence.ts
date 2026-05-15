/**
 * Presence detection — knows if the user is home or away.
 *
 * Two independent mechanisms:
 *
 *  DEPARTURE (Mikrotik ARP watcher)
 *    Every MAC_POLL_MS the router's ARP table is fetched via its REST API.
 *    If PHONE_MAC has been absent for > AWAY_TIMEOUT_MS → run departure scene.
 *
 *  ARRIVAL (GPS, pushed by the mobile app via POST /location)
 *    handleLocation() computes haversine distance from home coordinates.
 *    If distance < ARRIVAL_RADIUS_M and state is 'away' → run arrival scene.
 *    Returns next_ping_ms so the app adapts its polling frequency.
 */

import Logger from '../logger';

// ── Env ───────────────────────────────────────────────────────────────────────

const HOME_LAT = parseFloat(process.env.HOME_LAT ?? '0');
const HOME_LNG = parseFloat(process.env.HOME_LNG ?? '0');
const PHONE_MAC = (process.env.PHONE_MAC ?? '').toLowerCase().trim();
const PHONE_IP = (process.env.PHONE_IP ?? '').trim(); // optional fixed IP for precise ARP check
const MIKROTIK_IP = process.env.MIKROTIK_IP ?? '10.0.0.1';
const MIKROTIK_USER = process.env.MIKROTIK_USER ?? 'api-ro';
const MIKROTIK_PASS = process.env.MIKROTIK_PASS ?? '';
const AWAY_TIMEOUT_MS =
    parseInt(process.env.PRESENCE_AWAY_TIMEOUT_MIN ?? '15') * 60_000;
const ARRIVAL_RADIUS_M = parseInt(
    process.env.PRESENCE_ARRIVAL_RADIUS_M ?? '200',
);
const MAC_POLL_MS = parseInt(process.env.PRESENCE_MAC_POLL_MS ?? '120000'); // 2 min

// Scene IDs to trigger directly — no LLM involved
const DEPARTURE_SCENE_ID = process.env.PRESENCE_DEPARTURE_SCENE ?? '';
const ARRIVAL_SCENE_ID = process.env.PRESENCE_ARRIVAL_SCENE ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PresenceState = 'home' | 'away' | 'unknown';

export interface LocationResponse {
    state: PresenceState;
    distance_m: number;
    next_ping_ms: number;
}

// ── Haversine ─────────────────────────────────────────────────────────────────

function haversine(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const R = 6_371_000;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(Δφ / 2) ** 2 +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Smart polling intervals ───────────────────────────────────────────────────

function nextPingMs(distanceM: number): number {
    if (distanceM > 50_000) return 10 * 60_000; // >50 km  → 10 min
    if (distanceM > 5_000) return 5 * 60_000; // >5 km   → 5 min
    if (distanceM > 1_000) return 2 * 60_000; // >1 km   → 2 min
    if (distanceM > 300) return 30_000; // >300 m  → 30 s
    return 15_000; // <300 m  → 15 s
}

// ── Mikrotik REST API ─────────────────────────────────────────────────────────

/**
 * Check if the phone is on the network via Mikrotik ARP.
 *
 * If PHONE_IP is set (fixed IP): query that specific entry and check
 * mac-address matches + status is "reachable". This avoids false positives
 * from stale ARP entries that can linger with the same MAC on old IPs.
 *
 * If PHONE_IP is not set: scan the full ARP table for the MAC (legacy).
 *
 * Returns true/false on success, null if the router is unreachable.
 */
/**
 * Parses Mikrotik duration strings like "23m1s", "1h2m3s", "45s" → milliseconds.
 */
function parseMikrotikDuration(s: string): number {
    let ms = 0;
    const d = s.match(/(\d+)d/); if (d) ms += parseInt(d[1]) * 86_400_000;
    const h = s.match(/(\d+)h/); if (h) ms += parseInt(h[1]) * 3_600_000;
    const m = s.match(/(\d+)m/); if (m) ms += parseInt(m[1]) * 60_000;
    const sec = s.match(/(\d+)s/); if (sec) ms += parseInt(sec[1]) * 1_000;
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
 *   - lastSeenAt = computed from DHCP last-seen (authoritative) or Date.now() if ARP reachable
 *
 * Using DHCP last-seen prevents the noisy "absent 2min / found / absent 2min" log
 * pattern caused by Android WiFi power-saving waking the radio briefly.
 */
async function checkPhoneOnNetwork(): Promise<NetworkCheckResult> {
    const auth = Buffer.from(`${MIKROTIK_USER}:${MIKROTIK_PASS}`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };
    const fail: NetworkCheckResult = { present: null };

    try {
        if (PHONE_IP) {
            const [dhcpRes, arpRes] = await Promise.all([
                fetch(`http://${MIKROTIK_IP}/rest/ip/dhcp-server/lease?address=${PHONE_IP}`, {
                    headers, signal: AbortSignal.timeout(5_000),
                }),
                fetch(`http://${MIKROTIK_IP}/rest/ip/arp?address=${PHONE_IP}`, {
                    headers, signal: AbortSignal.timeout(5_000),
                }),
            ]);

            if (!dhcpRes.ok && !arpRes.ok) {
                Logger.warn(`[presence] Mikrotik error: DHCP=${dhcpRes.status} ARP=${arpRes.status}`);
                return fail;
            }

            // DHCP: phone is associated to the network (survives WiFi power-save sleep)
            let dhcpBound = false;
            if (dhcpRes.ok) {
                const leases: { 'mac-address'?: string; status?: string }[] = await dhcpRes.json();
                const lease = leases[0];
                dhcpBound = lease?.['mac-address']?.toLowerCase() === PHONE_MAC &&
                            lease?.status === 'bound';
            }

            // ARP: real-time reachability (true only when phone is awake/responding)
            let arpReachable = false;
            if (arpRes.ok) {
                const entries: { 'mac-address'?: string; status?: string }[] = await arpRes.json();
                const entry = entries[0];
                arpReachable = entry?.['mac-address']?.toLowerCase() === PHONE_MAC &&
                               entry?.status === 'reachable';
            }

            // present = DHCP bound OR ARP reachable
            // DHCP handles sleep mode (phone stops responding to ARP but lease stays bound)
            // ARP handles the case where DHCP hasn't expired yet after true departure
            //   → departure is caught by the 15min absence timeout, not by DHCP expiry
            const present = dhcpBound || arpReachable;

            Logger.debug(`[presence] DHCP=${dhcpBound ? 'bound' : 'absent'} ARP=${arpReachable ? 'reachable' : 'stale'}`);
            return { present };
        } else {
            // Fallback: full ARP table scan
            const res = await fetch(`http://${MIKROTIK_IP}/rest/ip/arp`, {
                headers, signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) {
                Logger.warn(`[presence] Mikrotik ARP API returned ${res.status}`);
                return fail;
            }
            const entries: { 'mac-address'?: string; status?: string }[] = await res.json();
            const found = entries.some(
                (e) => e['mac-address']?.toLowerCase() === PHONE_MAC && e.status === 'reachable',
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
    private lastSeenOnNetwork: number | null = null;
    private macWatcherTimer: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly runScene: (id: string) => Promise<unknown>) {}

    getState(): PresenceState {
        return this.state;
    }

    /**
     * Called on every POST /location from the mobile app.
     * Checks arrival condition and returns next_ping_ms for adaptive polling.
     */
    handleLocation(
        lat: number,
        lng: number,
        _accuracy: number,
    ): LocationResponse {
        if (!HOME_LAT || !HOME_LNG) {
            Logger.warn('Presence: HOME_LAT / HOME_LNG not configured');
            return {
                state: this.state,
                distance_m: -1,
                next_ping_ms: 5 * 60_000,
            };
        }

        const distanceM = Math.round(haversine(lat, lng, HOME_LAT, HOME_LNG));
        Logger.info(
            `[presence] GPS update: ${distanceM}m from home` +
            ` (radius=${ARRIVAL_RADIUS_M}m, state=${this.state})`,
        );

        if (distanceM <= ARRIVAL_RADIUS_M && this.state === 'away') {
            Logger.info(`[presence] Within arrival radius → triggering arrival scene`);
            this.triggerArrival();
        } else if (distanceM <= ARRIVAL_RADIUS_M) {
            Logger.info(`[presence] Within radius but state=${this.state} — no scene triggered`);
        }

        return {
            state: this.state,
            distance_m: distanceM,
            next_ping_ms: nextPingMs(distanceM),
        };
    }

    start(): void {
        if (!PHONE_MAC) {
            Logger.warn(
                'Presence: PHONE_MAC not set — departure detection disabled',
            );
            return;
        }
        if (!MIKROTIK_PASS) {
            Logger.warn(
                'Presence: MIKROTIK_PASS not set — departure detection disabled',
            );
            return;
        }
        Logger.info(
            `Presence: MAC watcher started (router=${MIKROTIK_IP}, timeout=${
                AWAY_TIMEOUT_MS / 60_000
            } min)`,
        );
        this.macWatcherTimer = setInterval(() => this.checkMac(), MAC_POLL_MS);
        this.checkMac();
    }

    stop(): void {
        if (this.macWatcherTimer) {
            clearInterval(this.macWatcherTimer);
            this.macWatcherTimer = null;
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private async checkMac(): Promise<void> {
        const { present } = await checkPhoneOnNetwork();

        if (present === null) {
            Logger.warn('[presence] MAC check skipped (router unreachable)');
            return;
        }

        if (present) {
            // ARP confirmed the phone is actively reachable right now
            this.lastSeenOnNetwork = Date.now();
            if (this.state !== 'home') {
                Logger.info(`[presence] Phone on network → state=home (was ${this.state})`);
                this.state = 'home';
            }
            return;
        }

        // Phone not found and router responded
        if (this.lastSeenOnNetwork === null) {
            Logger.info(`[presence] Phone not found on first check → state=away`);
            this.state = 'away';
            return;
        }

        const absentMs = Date.now() - this.lastSeenOnNetwork;
        const absentMin = Math.round(absentMs / 60_000);
        // Only log at INFO when absence is long enough to be meaningful
        if (absentMs > 5 * 60_000) {
            Logger.info(`[presence] Phone absent for ${absentMin}min (timeout=${AWAY_TIMEOUT_MS / 60_000}min, state=${this.state})`);
        } else {
            Logger.debug(`[presence] Phone absent for ${absentMin}min (WiFi sleep likely)`);
        }

        if (absentMs > AWAY_TIMEOUT_MS && this.state !== 'away') {
            Logger.info(`[presence] Timeout reached → triggering departure scene`);
            this.triggerDeparture();
        }
    }

    private triggerDeparture(): void {
        this.state = 'away';
        if (!DEPARTURE_SCENE_ID) {
            Logger.warn(
                'Presence: departure detected but PRESENCE_DEPARTURE_SCENE not set',
            );
            return;
        }
        Logger.info(
            `Presence: DEPARTURE → running scene "${DEPARTURE_SCENE_ID}"`,
        );
        this.runScene(DEPARTURE_SCENE_ID).catch((e) =>
            Logger.error(`Presence departure scene error: ${e}`),
        );
    }

    private triggerArrival(): void {
        this.state = 'home';
        this.lastSeenOnNetwork = Date.now();
        if (!ARRIVAL_SCENE_ID) {
            Logger.warn(
                'Presence: arrival detected but PRESENCE_ARRIVAL_SCENE not set',
            );
            return;
        }
        Logger.info(`Presence: ARRIVAL → running scene "${ARRIVAL_SCENE_ID}"`);
        this.runScene(ARRIVAL_SCENE_ID).catch((e) =>
            Logger.error(`Presence arrival scene error: ${e}`),
        );
    }
}
