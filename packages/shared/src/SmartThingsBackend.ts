// packages/shared/src/SmartThingsBackend.ts
import type { StDevice } from './SmartThingsClient';
import { TvOfflineError } from './SmartThingsClient';
import type { TvBackend, TvStatus } from './TvBackend';
import { wakeOnLan } from './wakeOnLan';
import { loadTvConfig, TvConfig } from './smartThingsConfig';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pure : payload /components/main/status → TvStatus. */
export function parseStatus(raw: any): TvStatus {
    const main = raw?.main ?? raw ?? {};
    const power = main?.switch?.switch?.value === 'on' ? 'on' : 'off';
    const volume = main?.audioVolume?.volume?.value;
    const muteVal = main?.audioMute?.mute?.value ?? undefined;
    const input =
        main?.['samsungvd.mediaInputSource']?.inputSource?.value ??
        main?.mediaInputSource?.inputSource?.value ??
        undefined;
    return {
        power,
        volume: typeof volume === 'number' ? volume : undefined,
        muted: muteVal === undefined ? undefined : muteVal === 'muted',
        input: input ?? undefined,
    };
}

export interface SmartThingsBackendOpts {
    pollIntervalMs?: number;
    bootTimeoutMs?: number;
    settleAfterOnlineMs?: number;
    refreshSettleMs?: number;
}

export class SmartThingsBackend implements TvBackend {
    private cfg: TvConfig;
    private pollIntervalMs: number;
    private bootTimeoutMs: number;
    private settleAfterOnlineMs: number;
    private refreshSettleMs: number;

    constructor(
        private client: StDevice,
        cfg?: TvConfig,
        opts: SmartThingsBackendOpts = {},
    ) {
        this.cfg = cfg ?? loadTvConfig();
        this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
        this.bootTimeoutMs = opts.bootTimeoutMs ?? 30000;
        this.settleAfterOnlineMs = opts.settleAfterOnlineMs ?? 1500;
        this.refreshSettleMs = opts.refreshSettleMs ?? 2000;
    }

    async ensureOn(): Promise<string> {
        if ((await this.client.getHealth()) === 'ONLINE') {
            await this.setInput(this.cfg.chromecastInput);
            return 'TV déjà allumée — basculée sur le Chromecast.';
        }
        await wakeOnLan(this.cfg.mac, this.cfg.ip);
        const deadline = Date.now() + this.bootTimeoutMs;
        while (Date.now() < deadline) {
            await sleep(this.pollIntervalMs);
            if ((await this.client.getHealth()) === 'ONLINE') {
                await sleep(this.settleAfterOnlineMs);
                await this.setInput(this.cfg.chromecastInput);
                return 'TV allumée et basculée sur le Chromecast.';
            }
        }
        return 'TV allumée (WoL envoyé) — bascule sur le Chromecast manuelle si besoin.';
    }

    async powerOff(): Promise<string> {
        try {
            await this.client.sendCommands([
                { component: 'main', capability: 'switch', command: 'off' },
            ]);
        } catch (e) {
            if (e instanceof TvOfflineError) return 'La télé est déjà éteinte.';
            throw e;
        }
        return 'Télé éteinte.';
    }

    async setVolume(level: number): Promise<void> {
        const v = Math.max(0, Math.min(100, Math.round(level)));
        await this.client.sendCommands([
            {
                component: 'main',
                capability: 'audioVolume',
                command: 'setVolume',
                arguments: [v],
            },
        ]);
    }

    async setMute(mute: boolean): Promise<void> {
        await this.client.sendCommands([
            {
                component: 'main',
                capability: 'audioMute',
                command: mute ? 'mute' : 'unmute',
            },
        ]);
    }

    async setInput(source: string): Promise<void> {
        await this.client.sendCommands([
            {
                component: 'main',
                capability: 'samsungvd.mediaInputSource',
                command: 'setInputSource',
                arguments: [source],
            },
        ]);
    }

    async status(): Promise<TvStatus> {
        if ((await this.client.getHealth()) !== 'ONLINE')
            return { power: 'off' };
        await this.client.refresh();
        await sleep(this.refreshSettleMs);
        return parseStatus(await this.client.getStatusRaw());
    }
}
