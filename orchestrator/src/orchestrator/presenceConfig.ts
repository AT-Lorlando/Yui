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
export interface PresenceConfig {
    geofence: GeofenceConfig;
    mac: MacBurstConfig;
}

const DEFAULTS: PresenceConfig = {
    geofence: { enabled: true, radiusM: 150 },
    mac: { burstIntervalMs: 15000, burstWindowMs: 300000 },
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
    },
    file = CONFIG_FILE,
): PresenceConfig {
    const cur = loadPresenceConfig(file);
    const next = mergePresenceConfig({
        geofence: { ...cur.geofence, ...patch.geofence },
        mac: { ...cur.mac, ...patch.mac },
    });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return next;
}
