import axios, { AxiosInstance } from 'axios';
import dgram from 'dgram';
import Logger from './logger';

const SMARTTHINGS_BASE = 'https://api.smartthings.com/v1';

export interface TvStatus {
    power: 'on' | 'off' | 'unknown';
    volume?: number;
    muted?: boolean;
    inputSource?: string;
}

function sendWol(mac: string, tvIp: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const hex = mac.replace(/[:\-]/g, '');
        if (hex.length !== 12) { reject(new Error(`Invalid MAC: ${mac}`)); return; }

        const macBytes = Buffer.from(hex, 'hex');
        const magic = Buffer.alloc(6 + 16 * 6);
        magic.fill(0xff, 0, 6);
        for (let i = 0; i < 16; i++) macBytes.copy(magic, 6 + i * 6);

        // Subnet broadcast from TV IP, e.g. 10.0.0.133 → 10.0.0.255
        const broadcast = tvIp.replace(/\.\d+$/, '.255');

        const sock = dgram.createSocket('udp4');
        sock.once('error', reject);
        sock.bind(() => {
            sock.setBroadcast(true);
            sock.send(magic, 9, broadcast, (err) => {
                sock.close();
                if (err) reject(err); else resolve();
            });
        });
    });
}

export class SamsungController {
    private client: AxiosInstance;
    private deviceId: string;
    private mac: string | undefined;
    private tvIp: string | undefined;

    constructor(token: string, deviceId: string, mac?: string, tvIp?: string) {
        this.deviceId = deviceId;
        this.mac = mac;
        this.tvIp = tvIp;
        this.client = axios.create({
            baseURL: SMARTTHINGS_BASE,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        });
    }

    private async sendCommand(
        capability: string,
        command: string,
        args: unknown[] = [],
    ): Promise<void> {
        const body = {
            commands: [
                {
                    component: 'main',
                    capability,
                    command,
                    ...(args.length > 0 && { arguments: args }),
                },
            ],
        };
        await this.client.post(`/devices/${this.deviceId}/commands`, body);
        Logger.debug(`Samsung TV: ${capability}.${command}(${args.join(', ')})`);
    }

    async powerOn(): Promise<void> {
        // WoL works even when fully off; SmartThings switch.on works from standby
        if (this.mac && this.tvIp) {
            await sendWol(this.mac, this.tvIp);
            Logger.info(`WoL magic packet sent to ${this.mac} via ${this.tvIp.replace(/\.\d+$/, '.255')}`);
        }
        // Also send SmartThings command (works from standby / no-op if fully off)
        try {
            await this.sendCommand('switch', 'on');
        } catch {
            // Ignore if TV is unreachable — WoL packet is enough
        }
    }

    async powerOff(): Promise<void> {
        await this.sendCommand('switch', 'off');
    }

    /**
     * Full Chromecast preparation: WoL → wait for TV to boot → switch to HDMI3.
     * Polls until the TV responds to refresh, then switches input.
     */
    async prepareChromecast(): Promise<string> {
        // If already on, just switch input
        const status = await this.getStatus();
        if (status.power === 'on') {
            await this.setInputSource('HDMI3');
            return 'TV was already on — switched to Chromecast (HDMI3).';
        }

        // TV is off — send WoL and wait for it to boot
        await this.powerOn();

        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 3000));
            try {
                const probe = await this.client.post(`/devices/${this.deviceId}/commands`, {
                    commands: [{ component: 'main', capability: 'refresh', command: 'refresh' }],
                });
                const ok = probe.data?.results?.some((r: any) => r.status !== 'FAILED');
                if (ok) {
                    await this.setInputSource('HDMI3');
                    return 'TV powered on and switched to Chromecast (HDMI3).';
                }
            } catch {
                // still booting
            }
        }

        return 'TV powered on (WoL sent) but took too long to respond — Chromecast input may need to be switched manually.';
    }

    async setVolume(level: number): Promise<void> {
        const vol = Math.max(0, Math.min(100, Math.round(level)));
        await this.sendCommand('audioVolume', 'setVolume', [vol]);
    }

    async mute(): Promise<void> {
        await this.sendCommand('audioMute', 'mute');
    }

    async unmute(): Promise<void> {
        await this.sendCommand('audioMute', 'unmute');
    }

    async setInputSource(source: string): Promise<void> {
        await this.sendCommand('samsungvd.mediaInputSource', 'setInputSource', [source]);
    }

    async launchApp(appId: string): Promise<void> {
        // Samsung TVs expose app launch via the custom samsungvd.mediaInputSource
        // or via a custom capability. We use the SmartThings custom command.
        await this.sendCommand('custom.launchapp', 'launchApp', [appId]);
    }

    async getStatus(): Promise<TvStatus> {
        // Probe reachability: Samsung TVs don't push "off" events reliably,
        // so SmartThings often shows stale "on". A failed refresh means unreachable = off.
        try {
            const probe = await this.client.post(`/devices/${this.deviceId}/commands`, {
                commands: [{ component: 'main', capability: 'refresh', command: 'refresh' }],
            });
            const failed = probe.data?.results?.every((r: any) => r.status === 'FAILED');
            if (failed) return { power: 'off' };
        } catch {
            return { power: 'off' };
        }

        const res = await this.client.get(`/devices/${this.deviceId}/status`);
        const components = res.data?.components?.main ?? {};

        const volume = components?.audioVolume?.volume?.value;
        const muted = components?.audioMute?.mute?.value === 'muted';
        const inputSource = components?.['samsungvd.mediaInputSource']?.inputSource?.value;

        return {
            power: 'on',
            ...(volume !== undefined && { volume: Number(volume) }),
            muted,
            ...(inputSource && { inputSource }),
        };
    }

    async getSupportedInputs(): Promise<Array<{ id: string; name: string }>> {
        const res = await this.client.get(`/devices/${this.deviceId}/status`);
        const components = res.data?.components?.main ?? {};
        const supported = components?.['samsungvd.mediaInputSource']?.supportedInputSourcesMap?.value;
        return Array.isArray(supported) ? supported : [];
    }
}
