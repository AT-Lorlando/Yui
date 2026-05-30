// @ts-ignore — tuyapi ships JS with JSDoc types, not full TS declarations
import TuyAPI from 'tuyapi';
import Logger from './logger';
import {
    loadConfig,
    type Pump,
    type AmountKey,
    type IrrigationConfig,
} from './config';

export type PumpOrAll = Pump | 'all';

export interface PumpStatus {
    pump: Pump;
    name: string;
    active: boolean;
    remaining_seconds: number | null;
}

interface CountdownInfo {
    endsAt: number;
    timer: NodeJS.Timeout;
}

export class IrrigationController {
    private readonly deviceId: string;
    private readonly localKey: string;
    private readonly deviceIp: string;
    private readonly version: string;
    private readonly countdowns: Map<Pump, CountdownInfo> = new Map();

    constructor() {
        this.deviceId = process.env.TUYA_DEVICE_ID ?? '';
        this.localKey = process.env.TUYA_LOCAL_KEY ?? '';
        this.deviceIp = process.env.TUYA_DEVICE_IP ?? '';
        this.version = process.env.TUYA_VERSION ?? '3.3';
    }

    isConfigured(): boolean {
        return !!(this.deviceId && this.localKey && this.deviceIp);
    }

    private makeDevice() {
        return new TuyAPI({
            id: this.deviceId,
            key: this.localKey,
            ip: this.deviceIp,
            version: this.version,
        });
    }

    private async withDevice<T>(fn: (device: any) => Promise<T>): Promise<T> {
        const device = this.makeDevice();
        await device.find();
        await device.connect();
        try {
            return await fn(device);
        } finally {
            try {
                device.disconnect();
            } catch {
                /* ignore */
            }
        }
    }

    /** Resolve a target (pump name or "all") → list of pump letters. Case- and accent-insensitive. */
    resolveTarget(
        target: string,
        cfg: IrrigationConfig = loadConfig(),
    ): Pump[] {
        const norm = (s: string) =>
            s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
        const n = norm(target);
        if (
            n === 'all' ||
            n === 'tout' ||
            n === 'toutes' ||
            n === 'tous' ||
            n === 'les deux'
        ) {
            return ['A', 'B'];
        }
        const matches: Pump[] = [];
        for (const p of ['A', 'B'] as Pump[]) {
            if (norm(cfg.pumps[p].name) === n) matches.push(p);
        }
        if (matches.length === 0) {
            throw new Error(
                `Cible inconnue : "${target}". Noms valides : ${Object.values(
                    cfg.pumps,
                )
                    .map((p) => `"${p.name}"`)
                    .join(', ')} ou "all".`,
            );
        }
        return matches;
    }

    async getStatus(): Promise<PumpStatus[]> {
        const cfg = loadConfig();
        return this.withDevice(async (device) => {
            const data = await device.get({ schema: true });
            Logger.debug(`DPS raw: ${JSON.stringify(data.dps)}`);
            const now = Date.now();
            return (['A', 'B'] as Pump[]).map((pump) => {
                const active = !!data.dps[cfg.pumps[pump].dps];
                const cd = this.countdowns.get(pump);
                const remaining =
                    cd && active
                        ? Math.max(0, Math.round((cd.endsAt - now) / 1000))
                        : null;
                return {
                    pump,
                    name: cfg.pumps[pump].name,
                    active,
                    remaining_seconds: remaining,
                };
            });
        });
    }

    async startAmount(target: string, amount: AmountKey): Promise<string> {
        const cfg = loadConfig();
        const pumps = this.resolveTarget(target, cfg);
        const seconds = cfg.amounts[amount];
        if (!seconds) throw new Error(`Niveau inconnu : "${amount}"`);
        await this.startInternal(pumps, seconds, cfg);
        const label =
            pumps.length === 2
                ? 'Les deux pompes'
                : `${cfg.pumps[pumps[0]].name}`;
        return `${label} — arrosage ${amount} (${seconds}s).`;
    }

    private async startInternal(
        pumps: Pump[],
        seconds: number,
        cfg: IrrigationConfig,
    ): Promise<void> {
        await this.withDevice(async (device) => {
            for (const p of pumps) {
                await device.set({ dps: cfg.pumps[p].dps, set: true });
            }
        });
        const endsAt = Date.now() + seconds * 1000;
        for (const p of pumps) {
            const prev = this.countdowns.get(p);
            if (prev) clearTimeout(prev.timer);
            const timer = setTimeout(() => {
                this.stopInternal([p]).catch((err) =>
                    Logger.error(`auto-stop pump ${p} failed: ${err}`),
                );
            }, seconds * 1000);
            this.countdowns.set(p, { endsAt, timer });
        }
    }

    async stop(target: string = 'all'): Promise<string> {
        const cfg = loadConfig();
        const pumps = this.resolveTarget(target, cfg);
        await this.stopInternal(pumps);
        const label =
            pumps.length === 2 ? 'Les deux pompes' : cfg.pumps[pumps[0]].name;
        return `${label} arrêtée(s).`;
    }

    private async stopInternal(pumps: Pump[]): Promise<void> {
        const cfg = loadConfig();
        for (const p of pumps) {
            const cd = this.countdowns.get(p);
            if (cd) {
                clearTimeout(cd.timer);
                this.countdowns.delete(p);
            }
        }
        await this.withDevice(async (device) => {
            for (const p of pumps) {
                await device.set({ dps: cfg.pumps[p].dps, set: false });
            }
        });
    }

    async discoverDps(): Promise<Record<string, unknown>> {
        return this.withDevice(async (device) => {
            const data = await device.get({ schema: true });
            return data.dps as Record<string, unknown>;
        });
    }
}
