// Shadow of packages/mcp-irrigation/src/config.ts — exists here so the
// orchestrator can serve the config over HTTP without depending on the MCP
// child package. Schema must stay in sync.

import * as fs from 'fs';
import * as path from 'path';

const CONFIG_FILE = path.resolve(process.cwd(), 'data', 'irrigation.json');

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

const DEFAULT_CONFIG: IrrigationConfig = {
    pumps: {
        A: { name: 'Bonsai', dps: 1 },
        B: { name: 'Pompe B', dps: 2 },
    },
    amounts: { petit: 20, normal: 60, grand: 120 },
};

export function loadIrrigationConfig(): IrrigationConfig {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        return validateIrrigationConfig(JSON.parse(raw));
    } catch {
        return DEFAULT_CONFIG;
    }
}

export function saveIrrigationConfig(cfg: unknown): IrrigationConfig {
    const validated = validateIrrigationConfig(cfg);
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(validated, null, 2));
    return validated;
}

export function validateIrrigationConfig(cfg: any): IrrigationConfig {
    if (!cfg || typeof cfg !== 'object')
        throw new Error('config must be an object');
    if (!cfg.pumps?.A || !cfg.pumps?.B)
        throw new Error('pumps.A and pumps.B are required');
    if (!cfg.amounts) throw new Error('amounts is required');

    return {
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
