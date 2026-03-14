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

async function getMikrotikMacs(): Promise<string[]> {
    const url = `http://${MIKROTIK_IP}/rest/ip/arp`;
    const auth = Buffer.from(`${MIKROTIK_USER}:${MIKROTIK_PASS}`).toString(
        'base64',
    );
    try {
        const res = await fetch(url, {
            headers: { Authorization: `Basic ${auth}` },
            signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
            Logger.warn(`Presence: Mikrotik API returned ${res.status}`);
            return [];
        }
        const entries: { 'mac-address'?: string }[] = await res.json();
        return entries
            .map((e) => e['mac-address']?.toLowerCase())
            .filter((m): m is string => Boolean(m));
    } catch (e) {
        Logger.warn(`Presence: Mikrotik unreachable — ${e}`);
        return [];
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
        Logger.info(`Presence: ${distanceM}m from home (state=${this.state})`);

        if (distanceM <= ARRIVAL_RADIUS_M && this.state === 'away') {
            this.triggerArrival();
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
        const macs = await getMikrotikMacs();
        const found = macs.includes(PHONE_MAC);

        if (found) {
            this.lastSeenOnNetwork = Date.now();
            if (this.state === 'unknown') {
                Logger.info('Presence: phone on network → state=home');
                this.state = 'home';
            }
            return;
        }

        if (this.lastSeenOnNetwork === null) return; // never seen, stay unknown

        const absentMs = Date.now() - this.lastSeenOnNetwork;
        Logger.debug(
            `Presence: MAC absent for ${Math.round(absentMs / 60_000)} min`,
        );

        if (absentMs > AWAY_TIMEOUT_MS && this.state !== 'away') {
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
