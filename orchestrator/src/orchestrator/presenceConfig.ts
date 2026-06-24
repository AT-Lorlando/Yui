import fs from 'fs';
import path from 'path';
import { dataPath } from '@yui/shared';

const CONFIG_FILE = dataPath('presence.json');

export interface GeofenceConfig {
    enabled: boolean;
    radiusM: number;
}
export interface MacBurstConfig {
    burstIntervalMs: number;
    burstWindowMs: number;
}
export interface NetPollConfig {
    /** Intervalle du poll réseau filet de sécurité (auto-correction de l'état). */
    pollIntervalMs: number;
    /**
     * Fenêtre de fraîcheur du `last-seen` DHCP : au-delà, un bail encore `bound`
     * n'est plus considéré comme une présence (le bail survit au départ du tél.).
     */
    dhcpFreshnessMs: number;
}
export interface PresenceConfig {
    geofence: GeofenceConfig;
    mac: MacBurstConfig;
    net: NetPollConfig;
}

const DEFAULTS: PresenceConfig = {
    geofence: { enabled: true, radiusM: 150 },
    mac: { burstIntervalMs: 15000, burstWindowMs: 300000 },
    net: { pollIntervalMs: 120000, dhcpFreshnessMs: 900000 },
};

function clampNum(
    v: unknown,
    min: number,
    max: number,
    fallback: number,
): number {
    const n = Number(v);
    return Number.isFinite(n)
        ? Math.min(max, Math.max(min, Math.round(n)))
        : fallback;
}

/** Pure merge + clamp. Tolère un objet partiel/malformé. */
export function mergePresenceConfig(raw: unknown): PresenceConfig {
    const r = (raw ?? {}) as Record<string, any>;
    const g = (r.geofence ?? {}) as Record<string, unknown>;
    const m = (r.mac ?? {}) as Record<string, unknown>;
    const n = (r.net ?? {}) as Record<string, unknown>;
    return {
        geofence: {
            enabled:
                typeof g.enabled === 'boolean'
                    ? g.enabled
                    : DEFAULTS.geofence.enabled,
            radiusM: clampNum(g.radiusM, 80, 500, DEFAULTS.geofence.radiusM),
        },
        mac: {
            burstIntervalMs: clampNum(
                m.burstIntervalMs,
                5000,
                60000,
                DEFAULTS.mac.burstIntervalMs,
            ),
            burstWindowMs: clampNum(
                m.burstWindowMs,
                60000,
                900000,
                DEFAULTS.mac.burstWindowMs,
            ),
        },
        net: {
            pollIntervalMs: clampNum(
                n.pollIntervalMs,
                30000,
                600000,
                DEFAULTS.net.pollIntervalMs,
            ),
            dhcpFreshnessMs: clampNum(
                n.dhcpFreshnessMs,
                120000,
                3600000,
                DEFAULTS.net.dhcpFreshnessMs,
            ),
        },
    };
}

export function loadPresenceConfig(file = CONFIG_FILE): PresenceConfig {
    try {
        return mergePresenceConfig(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch {
        return mergePresenceConfig({});
    }
}

export function savePresenceConfig(
    patch: {
        geofence?: Partial<GeofenceConfig>;
        mac?: Partial<MacBurstConfig>;
        net?: Partial<NetPollConfig>;
    },
    file = CONFIG_FILE,
): PresenceConfig {
    const cur = loadPresenceConfig(file);
    const next = mergePresenceConfig({
        geofence: { ...cur.geofence, ...patch.geofence },
        mac: { ...cur.mac, ...patch.mac },
        net: { ...cur.net, ...patch.net },
    });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return next;
}
