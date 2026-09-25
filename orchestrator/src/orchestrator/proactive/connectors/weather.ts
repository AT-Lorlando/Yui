import { evaluateWeather } from '../watchers/weather';
import { fromCandidate } from '../events';
import type { Event, Fact } from '../events';
import type { ConnectorDef, ConnectorContext } from '../connector';
import type { WeatherWatcherConfig } from '../types';

const DEFAULT_NORMALS = [8, 10, 14, 17, 21, 25, 28, 28, 24, 18, 12, 9];

function cfgOf(ctx: ConnectorContext): WeatherWatcherConfig {
    const s = ctx.settings;
    return {
        pollMinutes: Number(s.pollMinutes ?? 30),
        monthlyNormalsC: Array.isArray(s.monthlyNormalsC)
            ? (s.monthlyNormalsC as number[])
            : DEFAULT_NORMALS,
        anomalyMarginC: Number(s.anomalyMarginC ?? 8),
        hotThresholdC: Number(s.hotThresholdC ?? 32),
        rainThresholdMm: Number(s.rainThresholdMm ?? 2),
    };
}

/** Une alerte météo vaut jusqu'à la fin de la journée. */
function untilMidnight(now: number): number {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0);
    return d.getTime() - now;
}

export const weatherConnector: ConnectorDef = {
    id: 'weather',
    name: 'Météo',
    description: 'Anomalies météo (canicule, pluie forte, écart aux normales).',
    defaultEnabled: true,
    pollMinutes: 30,
    settings: [
        {
            key: 'pollMinutes',
            label: 'Intervalle (min)',
            type: 'number',
            default: 30,
        },
        {
            key: 'anomalyMarginC',
            label: 'Écart aux normales (°C)',
            type: 'number',
            default: 8,
        },
        {
            key: 'hotThresholdC',
            label: 'Seuil canicule (°C)',
            type: 'number',
            default: 32,
        },
        {
            key: 'rainThresholdMm',
            label: 'Seuil pluie (mm)',
            type: 'number',
            default: 2,
        },
        {
            key: 'maxPerHour',
            label: 'Max événements / heure',
            type: 'number',
            default: 6,
        },
    ],
    async events(ctx): Promise<Event[]> {
        const now = ctx.now();
        // Clé = sujet nu (`rain-now`, `temp-anomaly`…) : la dédup par cooldown
        // évite la répétition, le ttl borne l'alerte à la journée.
        return (
            await evaluateWeather(ctx.callTool, cfgOf(ctx), new Date(now))
        ).map((c) => ({
            ...fromCandidate(c, now),
            ttlMs: untilMidnight(now),
        }));
    },
    async snapshot(ctx): Promise<Fact[]> {
        const cur = (await ctx.callTool('get_current_weather')) as {
            city?: string;
            temperature_c?: number;
        } | null;
        if (typeof cur?.temperature_c !== 'number') return [];
        return [
            {
                label: 'Météo',
                value: `${cur.temperature_c}°C à ${cur.city ?? 'la maison'}`,
            },
        ];
    },
};
