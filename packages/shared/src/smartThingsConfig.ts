import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from './dataPaths';

export interface SmartThingsCreds {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    deviceId: string;
}

export interface TvConfig {
    mac: string;
    ip: string;
    chromecastInput: string;
    /** Libellés des entrées nommées à la main (code → nom). */
    inputs: Record<string, string>;
    /** Entrées découvertes sur la TV (supportedInputSources), persistées pour
     *  que l'enum de `tv_set_input` les connaisse dès le prochain démarrage. */
    knownInputs?: string[];
}

/**
 * Catalogue des entrées : config nommée + découvertes (persistées) + vivantes,
 * dédoublonné, dans cet ordre, libellé = nom configuré ou le code lui-même.
 * Avant (09/10/2026) seules les trois entrées nommées étaient proposées :
 * le Shield sur HDMI4 n'apparaissait nulle part.
 */
export function inputCatalog(
    cfg: Pick<TvConfig, 'inputs' | 'knownInputs'>,
    live: string[] = [],
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const code of [
        ...Object.keys(cfg.inputs ?? {}),
        ...(cfg.knownInputs ?? []),
        ...live,
    ]) {
        if (!code || code in out) continue;
        out[code] = cfg.inputs?.[code] ?? code;
    }
    return out;
}

/** Nouvelles entrées à retenir ; null si rien de neuf. */
export function mergeKnownInputs(
    cfg: Pick<TvConfig, 'inputs' | 'knownInputs'>,
    live: string[],
): string[] | null {
    const known = new Set([
        ...Object.keys(cfg.inputs ?? {}),
        ...(cfg.knownInputs ?? []),
    ]);
    const fresh: string[] = [];
    for (const c of live) {
        if (c && !known.has(c)) {
            known.add(c);
            fresh.push(c);
        }
    }
    if (!fresh.length) return null;
    return [...(cfg.knownInputs ?? []), ...fresh];
}

const CREDS_FILE = 'smartthings.json';
const TV_CONFIG_FILE = 'smartthings-tv.json';

const DEFAULT_TV_CONFIG: TvConfig = {
    mac: 'D0:D0:03:30:48:4B',
    ip: '10.0.0.133',
    chromecastInput: 'HDMI3',
    inputs: { HDMI3: 'Chromecast', HDMI2: 'NintendoSwitch', dtv: 'TV' },
};

export function loadSmartThingsCreds(): SmartThingsCreds {
    const file = dataPath(CREDS_FILE);
    if (!fs.existsSync(file)) {
        throw new Error(
            `SmartThings credentials introuvables (${file}). Lance "npm run setup:smartthings".`,
        );
    }
    const c = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!c.clientId || !c.clientSecret || !c.refreshToken || !c.deviceId) {
        throw new Error(
            `SmartThings credentials incomplets (${file}). Relance "npm run setup:smartthings".`,
        );
    }
    return c as SmartThingsCreds;
}

export function saveSmartThingsCreds(creds: SmartThingsCreds): void {
    const file = dataPath(CREDS_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function loadTvConfig(): TvConfig {
    const file = dataPath(TV_CONFIG_FILE);
    if (!fs.existsSync(file)) return { ...DEFAULT_TV_CONFIG };
    try {
        const c = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return { ...DEFAULT_TV_CONFIG, ...c };
    } catch {
        return { ...DEFAULT_TV_CONFIG };
    }
}

export function saveTvConfig(cfg: TvConfig): void {
    const file = dataPath(TV_CONFIG_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
