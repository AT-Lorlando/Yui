import fs from 'fs';
import path from 'path';

const CONFIG_FILE = path.resolve(process.cwd(), 'data/presence.json');

export const MIN_RADIUS_M = 80;
export const MAX_RADIUS_M = 500;

export interface GeofenceConfig {
    enabled: boolean;
    radiusM: number;
}

const DEFAULTS: GeofenceConfig = { enabled: true, radiusM: 150 };

/** Pure merge + clamp. Tolère un objet partiel ou malformé. */
export function mergeGeofenceConfig(raw: unknown): GeofenceConfig {
    const g = ((raw as Record<string, unknown>)?.geofence ?? {}) as Record<
        string,
        unknown
    >;
    const radius = Number(g.radiusM);
    return {
        enabled: typeof g.enabled === 'boolean' ? g.enabled : DEFAULTS.enabled,
        radiusM: Number.isFinite(radius)
            ? Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(radius)))
            : DEFAULTS.radiusM,
    };
}

export function loadGeofenceConfig(file = CONFIG_FILE): GeofenceConfig {
    try {
        return mergeGeofenceConfig(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch {
        return { ...DEFAULTS };
    }
}

export function saveGeofenceConfig(
    patch: Partial<GeofenceConfig>,
    file = CONFIG_FILE,
): GeofenceConfig {
    const current = loadGeofenceConfig(file);
    const next = mergeGeofenceConfig({ geofence: { ...current, ...patch } });
    fs.writeFileSync(file, JSON.stringify({ geofence: next }, null, 2));
    return next;
}
