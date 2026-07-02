// orchestrator/src/orchestrator/configCatalog.ts
//
// What the orchestrator EXPECTS — surfaced to the app so the front can render
// placeholders instead of having the user guess. Two catalogs:
//   - expectedDomains(): the domain prompt files the orchestrator can load,
//     derived from SERVER_GROUPS (so the front lists the domain slots even when
//     the .md doesn't exist yet).
//   - INTEGRATIONS_CATALOG: per-MCP-server connection env vars, with examples
//     and a `secret` flag (secrets stay in .env — shown read-only on the front).
import * as path from 'path';
import { SERVER_GROUPS } from './serverGroups';

export interface ExpectedDomain {
    domain: string; // manifest domain id (basename of the file, sans .md)
    file: string; // conventional prompt file, e.g. "domotique.md"
    groups: string[]; // server-group names that trigger this domain prompt
}

/** Distinct domain prompt files + the groups that trigger each. Pure. */
export function expectedDomains(): ExpectedDomain[] {
    const byFile = new Map<string, ExpectedDomain>();
    for (const g of SERVER_GROUPS) {
        if (!g.promptFile) continue;
        const existing = byFile.get(g.promptFile);
        if (existing) {
            if (!existing.groups.includes(g.name)) existing.groups.push(g.name);
        } else {
            byFile.set(g.promptFile, {
                domain: path.basename(g.promptFile, '.md'),
                file: g.promptFile,
                groups: [g.name],
            });
        }
    }
    return [...byFile.values()];
}

export interface CatalogKey {
    key: string;
    label: string;
    example: string;
    /** Secret → stays in .env, shown read-only on the front (not set here). */
    secret?: boolean;
}

/**
 * Per-server connection env vars the orchestrator reads. Non-secret keys are
 * editable via data/integrations.json; secret keys are informational (managed
 * in .env). Mirrors .env.example + each package's process.env usage.
 */
export const INTEGRATIONS_CATALOG: Record<string, CatalogKey[]> = {
    'mcp-hue': [
        {
            key: 'HUE_BRIDGE_IP',
            label: 'IP du bridge Hue',
            example: '10.0.0.42',
        },
        {
            key: 'HUE_USERNAME',
            label: 'Clé API bridge',
            example: '',
            secret: true,
        },
        { key: 'GOVEE_IP', label: 'IP lampe Govee', example: '10.0.0.199' },
        { key: 'GOVEE_NAME', label: 'Nom Govee', example: 'Govee Ambiance' },
        { key: 'GOVEE_ROOM', label: 'Pièce Govee', example: 'Salon' },
        { key: 'GOVEE_MODE', label: 'Mode Govee', example: 'ambiance' },
    ],
    'mcp-nuki': [
        { key: 'NUKI_HOST', label: 'IP bridge Nuki', example: '10.0.0.7' },
        { key: 'NUKI_PORT', label: 'Port bridge Nuki', example: '8080' },
        { key: 'NUKI_TOKEN', label: 'Token bridge', example: '', secret: true },
    ],
    'mcp-spotify': [
        {
            key: 'SPOTIFY_DEFAULT_SPEAKER',
            label: 'Enceinte par défaut',
            example: 'WiiM Ultra-65B6',
        },
        {
            key: 'SPOTIFY_SEEDER_DEVICE',
            label: 'Device seeder',
            example: 'Chromecaste',
        },
        {
            key: 'BROADLINK_HOST',
            label: 'IP Broadlink (ampli)',
            example: '10.0.0.50',
        },
        {
            key: 'SPOTIFY_CLIENT_ID',
            label: 'Client ID',
            example: '',
            secret: true,
        },
        {
            key: 'SPOTIFY_CLIENT_SECRET',
            label: 'Client secret',
            example: '',
            secret: true,
        },
        {
            key: 'SPOTIFY_REFRESH_TOKEN',
            label: 'Refresh token',
            example: '',
            secret: true,
        },
    ],
    'mcp-chromecast': [
        {
            key: 'SMARTTHINGS_TV_IP',
            label: 'IP TV Samsung',
            example: '10.0.0.133',
        },
        {
            key: 'SMARTTHINGS_TV_MAC',
            label: 'MAC TV (WoL)',
            example: 'AA:BB:CC:DD:EE:FF',
        },
        {
            key: 'CHROMECAST_HOST',
            label: 'IP Chromecast salon',
            example: '10.0.0.192',
        },
    ],
    'mcp-samsung': [
        {
            key: 'SMARTTHINGS_TV_IP',
            label: 'IP TV Samsung',
            example: '10.0.0.133',
        },
        {
            key: 'SMARTTHINGS_TV_MAC',
            label: 'MAC TV (WoL)',
            example: 'AA:BB:CC:DD:EE:FF',
        },
        {
            key: 'SMARTTHINGS_TOKEN',
            label: 'Token SmartThings',
            example: '',
            secret: true,
        },
    ],
    'mcp-somfy': [
        { key: 'TAHOMA_HOST', label: 'IP box Tahoma', example: '10.0.0.60' },
        { key: 'TAHOMA_PORT', label: 'Port Tahoma', example: '8443' },
        {
            key: 'TAHOMA_TOKEN',
            label: 'Token Tahoma',
            example: '',
            secret: true,
        },
    ],
    'mcp-weather': [
        { key: 'WEATHER_CITY', label: 'Ville', example: 'Paris' },
        { key: 'WEATHER_LAT', label: 'Latitude', example: '48.85' },
        { key: 'WEATHER_LON', label: 'Longitude', example: '2.35' },
    ],
    'mcp-irrigation': [
        {
            key: 'TUYA_DEVICE_IP',
            label: 'IP device Tuya',
            example: '10.0.0.70',
        },
        { key: 'TUYA_DEVICE_ID', label: 'Device ID', example: '' },
        {
            key: 'TUYA_LOCAL_KEY',
            label: 'Clé locale',
            example: '',
            secret: true,
        },
    ],
    'mcp-yoji': [
        {
            key: 'YOJI_API_URL',
            label: "URL de l'API Yoji",
            example: 'http://localhost:3000/api/v1',
        },
        {
            key: 'YOJI_API_KEY',
            label: 'Clé API Yoji (optionnel)',
            example: '',
            secret: true,
        },
    ],
    'mcp-calendar': [
        {
            key: 'GOOGLE_CLIENT_ID',
            label: 'Client ID Google',
            example: '',
            secret: true,
        },
        {
            key: 'GOOGLE_REFRESH_TOKEN',
            label: 'Refresh token',
            example: '',
            secret: true,
        },
    ],
    'mcp-gmail': [
        {
            key: 'GOOGLE_CLIENT_ID',
            label: 'Client ID Google',
            example: '',
            secret: true,
        },
        {
            key: 'GOOGLE_REFRESH_TOKEN',
            label: 'Refresh token',
            example: '',
            secret: true,
        },
    ],
};
