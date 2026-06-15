// orchestrator/src/orchestrator/integrations.ts
//
// App-editable connection config (family B of the .env split — see
// docs/superpowers/specs/2026-06-15-app-editable-config-design.md).
//
// data/integrations.json maps each MCP server to env vars injected at its spawn:
//   { "mcp-hue": { "HUE_BRIDGE_IP": "10.0.0.42" }, ... }
// These take precedence over the package's own dotenv load (dotenv never
// overrides an already-set var), so editing this file + respawning the server
// is enough to repoint a device — no .env edit, no full restart.
import * as fs from 'fs';
import * as path from 'path';
import type { McpServerConfig } from './types';

export type IntegrationsMap = Record<string, Record<string, string>>;

const FILENAME = 'integrations.json';
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const SENSITIVE_RE = /(TOKEN|SECRET|KEY|PASS|REFRESH|CREDENTIAL)/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pure: returns new server configs with `env` populated from the map. */
export function applyIntegrations(
    servers: McpServerConfig[],
    map: IntegrationsMap,
): McpServerConfig[] {
    return servers.map((s) => {
        const entry = map[s.name];
        if (!entry || Object.keys(entry).length === 0) return { ...s };
        return { ...s, env: { ...entry } };
    });
}

/** Returns a list of human-readable validation errors (empty = valid). */
export function validateIntegrations(map: IntegrationsMap): string[] {
    const errors: string[] = [];
    if (!isPlainObject(map)) return ['integrations must be an object'];

    for (const [server, entry] of Object.entries(map)) {
        if (!isPlainObject(entry)) {
            errors.push(`"${server}" must map to an object of env vars`);
            continue;
        }
        for (const [key, value] of Object.entries(entry)) {
            if (!ENV_KEY_RE.test(key))
                errors.push(`"${server}.${key}" must be UPPER_SNAKE_CASE`);
            if (typeof value !== 'string' && typeof value !== 'number')
                errors.push(`"${server}.${key}" must be a string or number`);
        }
    }
    return errors;
}

/** Mask sensitive values (in case a token slipped in) for GET responses. */
export function maskIntegrations(map: IntegrationsMap): IntegrationsMap {
    const out: IntegrationsMap = {};
    for (const [server, entry] of Object.entries(map)) {
        out[server] = {};
        for (const [key, value] of Object.entries(entry)) {
            out[server][key] = SENSITIVE_RE.test(key) ? '••••••' : value;
        }
    }
    return out;
}

function fileFor(dir: string): string {
    return path.join(dir, FILENAME);
}

/** Read integrations.json (missing/invalid → {}). */
export function loadIntegrations(opts?: { dir?: string }): IntegrationsMap {
    const file = fileFor(opts?.dir ?? 'data');
    if (!fs.existsSync(file)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return isPlainObject(parsed) ? (parsed as IntegrationsMap) : {};
    } catch {
        return {};
    }
}

/** Coerce numbers to strings so on-disk values are always env-shaped. */
function normalize(map: IntegrationsMap): IntegrationsMap {
    const out: IntegrationsMap = {};
    for (const [server, entry] of Object.entries(map)) {
        out[server] = {};
        for (const [key, value] of Object.entries(entry)) {
            out[server][key] = String(value);
        }
    }
    return out;
}

/**
 * Validate a patch, deep-merge it per server into integrations.json, persist,
 * and return the full resolved map. Throws on invalid input.
 */
export function saveIntegrations(
    patch: IntegrationsMap,
    opts?: { dir?: string },
): IntegrationsMap {
    const errors = validateIntegrations(patch);
    if (errors.length) throw new Error(errors.join('; '));

    const dir = opts?.dir ?? 'data';
    const current = loadIntegrations({ dir });
    const next: IntegrationsMap = { ...current };
    for (const [server, entry] of Object.entries(patch)) {
        next[server] = { ...(next[server] ?? {}), ...entry };
    }
    const normalized = normalize(next);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileFor(dir), JSON.stringify(normalized, null, 2));
    return normalized;
}
