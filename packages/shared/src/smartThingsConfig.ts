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
    inputs: Record<string, string>;
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(creds, null, 2));
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
