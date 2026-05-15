// @ts-ignore — tuyapi ships JS with JSDoc types, not full TS declarations
import TuyAPI from 'tuyapi';
import Logger from './logger';

export interface PumpStatus {
    pump: 'A' | 'B';
    active: boolean;
    remaining_seconds: number | null;
}

/**
 * DPS (Data Points) for the Mooklin Roam double-pump irrigation system.
 * Tuya DPS vary per firmware — use `discover_dps` tool to confirm your device's values,
 * then override via env vars.
 *
 * Defaults match the most common Tuya water-timer profile:
 *   DPS 1  = Pump A switch (bool)
 *   DPS 2  = Pump B switch (bool)
 *   DPS 11 = Pump A countdown remaining (int, seconds)
 *   DPS 12 = Pump B countdown remaining (int, seconds)
 */
const DPS = {
    pumpA:   parseInt(process.env.TUYA_DPS_PUMP_A    ?? '1'),
    pumpB:   parseInt(process.env.TUYA_DPS_PUMP_B    ?? '2'),
    timerA:  parseInt(process.env.TUYA_DPS_TIMER_A   ?? '11'),
    timerB:  parseInt(process.env.TUYA_DPS_TIMER_B   ?? '12'),
};

export class IrrigationController {
    private readonly deviceId:  string;
    private readonly localKey:  string;
    private readonly deviceIp:  string;
    private readonly version:   string;

    constructor() {
        this.deviceId = process.env.TUYA_DEVICE_ID  ?? '';
        this.localKey = process.env.TUYA_LOCAL_KEY  ?? '';
        this.deviceIp = process.env.TUYA_DEVICE_IP  ?? '';
        this.version  = process.env.TUYA_VERSION    ?? '3.3';
    }

    isConfigured(): boolean {
        return !!(this.deviceId && this.localKey && this.deviceIp);
    }

    private makeDevice() {
        return new TuyAPI({
            id:      this.deviceId,
            key:     this.localKey,
            ip:      this.deviceIp,
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
            try { device.disconnect(); } catch {}
        }
    }

    async getStatus(): Promise<PumpStatus[]> {
        return this.withDevice(async (device) => {
            const data = await device.get({ schema: true });
            Logger.debug(`DPS raw: ${JSON.stringify(data.dps)}`);
            return [
                {
                    pump: 'A' as const,
                    active: !!data.dps[DPS.pumpA],
                    remaining_seconds: data.dps[DPS.timerA] ?? null,
                },
                {
                    pump: 'B' as const,
                    active: !!data.dps[DPS.pumpB],
                    remaining_seconds: data.dps[DPS.timerB] ?? null,
                },
            ];
        });
    }

    async startPump(pump: 'A' | 'B' | 'both', durationSeconds: number): Promise<string> {
        return this.withDevice(async (device) => {
            if (pump === 'A' || pump === 'both') {
                await device.set({ dps: DPS.timerA, set: durationSeconds });
                await device.set({ dps: DPS.pumpA,  set: true });
            }
            if (pump === 'B' || pump === 'both') {
                await device.set({ dps: DPS.timerB, set: durationSeconds });
                await device.set({ dps: DPS.pumpB,  set: true });
            }
            const label = pump === 'both' ? 'Pompes A et B' : `Pompe ${pump}`;
            return `${label} démarrée pour ${durationSeconds} secondes.`;
        });
    }

    async stopPump(pump: 'A' | 'B' | 'both' = 'both'): Promise<string> {
        return this.withDevice(async (device) => {
            if (pump === 'A' || pump === 'both') {
                await device.set({ dps: DPS.pumpA, set: false });
            }
            if (pump === 'B' || pump === 'both') {
                await device.set({ dps: DPS.pumpB, set: false });
            }
            const label = pump === 'both' ? 'Pompes A et B' : `Pompe ${pump}`;
            return `${label} arrêtée.`;
        });
    }

    /** Dumps all raw DPS from the device — useful to identify unknown data points. */
    async discoverDps(): Promise<Record<string, unknown>> {
        return this.withDevice(async (device) => {
            const data = await device.get({ schema: true });
            return data.dps as Record<string, unknown>;
        });
    }
}
