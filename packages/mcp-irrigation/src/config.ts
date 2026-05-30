import * as fs from 'fs';
import * as path from 'path';

export type Pump = 'A' | 'B';
export type AmountKey = 'petit' | 'normal' | 'grand';

export interface PumpConfig {
    name: string;
    dps: number;
}

export interface IrrigationConfig {
    pumps: Record<Pump, PumpConfig>;
    amounts: Record<AmountKey, number>;
}

const HERE = __dirname;
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');
export const CONFIG_FILE = path.join(PROJECT_ROOT, 'data', 'irrigation.json');

export const DEFAULT_CONFIG: IrrigationConfig = {
    pumps: {
        A: { name: 'Bonsai', dps: 1 },
        B: { name: 'Pompe B', dps: 2 },
    },
    amounts: { petit: 20, normal: 60, grand: 120 },
};

const AMOUNT_KEYS: AmountKey[] = ['petit', 'normal', 'grand'];

export function loadConfig(): IrrigationConfig {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return mergeDefaults(parsed);
    } catch {
        return DEFAULT_CONFIG;
    }
}

export function saveConfig(cfg: IrrigationConfig): void {
    const validated = validate(cfg);
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(validated, null, 2));
}

/** Validates structure + clamps durations to [1, 1800]. Throws on missing fields. */
export function validate(cfg: any): IrrigationConfig {
    if (!cfg || typeof cfg !== 'object')
        throw new Error('config must be an object');
    if (!cfg.pumps || !cfg.pumps.A || !cfg.pumps.B) {
        throw new Error('config.pumps.A and config.pumps.B are required');
    }
    if (!cfg.amounts) throw new Error('config.amounts is required');

    const out: IrrigationConfig = {
        pumps: {
            A: cleanPump(cfg.pumps.A, DEFAULT_CONFIG.pumps.A),
            B: cleanPump(cfg.pumps.B, DEFAULT_CONFIG.pumps.B),
        },
        amounts: {
            petit: clampSeconds(
                cfg.amounts.petit,
                DEFAULT_CONFIG.amounts.petit,
            ),
            normal: clampSeconds(
                cfg.amounts.normal,
                DEFAULT_CONFIG.amounts.normal,
            ),
            grand: clampSeconds(
                cfg.amounts.grand,
                DEFAULT_CONFIG.amounts.grand,
            ),
        },
    };
    return out;
}

function cleanPump(p: any, fallback: PumpConfig): PumpConfig {
    const name =
        typeof p?.name === 'string' && p.name.trim()
            ? p.name.trim()
            : fallback.name;
    const dps = Number.isInteger(p?.dps) ? p.dps : fallback.dps;
    return { name, dps };
}

function clampSeconds(v: any, fallback: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(1800, Math.round(n)));
}

function mergeDefaults(parsed: any): IrrigationConfig {
    try {
        return validate(parsed);
    } catch {
        return DEFAULT_CONFIG;
    }
}

export { AMOUNT_KEYS };
