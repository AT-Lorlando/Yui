import http from 'http';
import dgram from 'dgram';
import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';

const TOKEN_FILE = path.resolve(process.cwd(), 'data/samsung-tv-token.json');

export interface TvStatus {
    power: 'on' | 'off';
    inputSource?: string;
}

// ── WoL ───────────────────────────────────────────────────────────────────────

function sendWol(mac: string, tvIp: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const hex = mac.replace(/[:\-]/g, '');
        if (hex.length !== 12) { reject(new Error(`Invalid MAC: ${mac}`)); return; }

        const macBytes = Buffer.from(hex, 'hex');
        const magic = Buffer.alloc(6 + 16 * 6);
        magic.fill(0xff, 0, 6);
        for (let i = 0; i < 16; i++) macBytes.copy(magic, 6 + i * 6);

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

// ── Token persistence ─────────────────────────────────────────────────────────

function loadToken(): string | null {
    try {
        if (fs.existsSync(TOKEN_FILE))
            return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')).token ?? null;
    } catch { /* ignore */ }
    return null;
}

function saveToken(token: string): void {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }));
    Logger.info('Samsung TV token saved');
}

// ── Input key map ─────────────────────────────────────────────────────────────

const INPUT_KEY_MAP: Record<string, string> = {
    HDMI1: 'KEY_HDMI1',
    HDMI2: 'KEY_HDMI2',
    HDMI3: 'KEY_HDMI3',
    TV:    'KEY_TV',
    AV:    'KEY_AV',
};

// ── Controller ────────────────────────────────────────────────────────────────

export class SamsungController {
    private tvIp: string;
    private mac?: string;

    constructor(tvIp: string, mac?: string) {
        this.tvIp = tvIp;
        this.mac = mac;
    }

    /** Returns true if the TV WebSocket API responds (= TV is on). */
    async isOn(): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get(
                `http://${this.tvIp}:8001/api/v2/`,
                { timeout: 2500 },
                (res) => { resolve(res.statusCode === 200); res.resume(); },
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    /**
     * Sends a batch of remote key presses over a single WebSocket connection.
     * Keys are sent 120 ms apart (TV processes ~8 keys/s reliably).
     */
    private sendKeys(keys: string[]): Promise<void> {
        if (keys.length === 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const appName = Buffer.from('Yui').toString('base64');
            const token   = loadToken();
            const url     = `ws://${this.tvIp}:8001/api/v2/channels/samsung.remote.control`
                          + `?name=${appName}${token ? `&token=${token}` : ''}`;

            const ws = new WebSocket(url);
            let done = false;

            ws.addEventListener('open', async () => {
                for (const key of keys) {
                    ws.send(JSON.stringify({
                        method: 'ms.remote.control',
                        params: { Cmd: 'Click', DataOfCmd: key, TypeOfRemote: 'SendRemoteKey' },
                    }));
                    await new Promise(r => setTimeout(r, 120));
                }
                ws.close();
                if (!done) { done = true; resolve(); }
            });

            ws.addEventListener('message', (e: MessageEvent) => {
                try {
                    const data = JSON.parse(e.data as string);
                    const t = data?.data?.token;
                    if (t) saveToken(String(t));
                } catch { /* ignore */ }
            });

            ws.addEventListener('error', (e: Event) => {
                if (!done) { done = true; reject(new Error(`WebSocket error: ${e}`)); }
            });
        });
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    async powerOn(): Promise<void> {
        if (this.mac) {
            await sendWol(this.mac, this.tvIp);
            Logger.info(`WoL sent to ${this.mac}`);
        } else {
            throw new Error('No MAC address configured — cannot power on TV');
        }
    }

    async powerOff(): Promise<void> {
        await this.sendKeys(['KEY_POWEROFF']);
    }

    /**
     * WoL → wait for TV to boot → switch to HDMI3.
     * Used by tv_prepare_chromecast and also internally by mcp-chromecast.
     */
    async prepareChromecast(): Promise<string> {
        if (await this.isOn()) {
            await this.sendKeys(['KEY_HDMI3']);
            return 'TV already on — switched to Chromecast (HDMI3).';
        }

        await this.powerOn();

        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 3000));
            if (await this.isOn()) {
                await new Promise(r => setTimeout(r, 1500)); // let WS server start
                await this.sendKeys(['KEY_HDMI3']);
                return 'TV powered on and switched to Chromecast (HDMI3).';
            }
        }
        return 'TV powered on (WoL sent) but took too long to respond — switch HDMI3 manually.';
    }

    /**
     * Absolute volume: reset to 0 with 50 KEY_VOLDOWN, then go up to target.
     * One WS connection, keys sent 120 ms apart — max ~18 s for level=100.
     */
    async setVolume(level: number): Promise<void> {
        const target = Math.max(0, Math.min(100, Math.round(level)));
        const keys = [
            ...Array(50).fill('KEY_VOLDOWN'),
            ...Array(target).fill('KEY_VOLUP'),
        ];
        await this.sendKeys(keys);
    }

    async mute(): Promise<void>   { await this.sendKeys(['KEY_MUTE']); }
    async unmute(): Promise<void> { await this.sendKeys(['KEY_MUTE']); }

    async setInputSource(source: string): Promise<void> {
        const key = INPUT_KEY_MAP[source.toUpperCase()]
                 ?? `KEY_${source.toUpperCase()}`;
        await this.sendKeys([key]);
    }

    async launchApp(appId: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const body = JSON.stringify({ id: appId, appId });
            const req = http.request(
                {
                    hostname: this.tvIp,
                    port: 8001,
                    path: `/api/v2/applications/${encodeURIComponent(appId)}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                    timeout: 5000,
                },
                (res) => { res.resume(); resolve(); },
            );
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    async getStatus(): Promise<TvStatus> {
        return { power: (await this.isOn()) ? 'on' : 'off' };
    }

    getSupportedInputs(): Array<{ id: string; name: string }> {
        return [
            { id: 'HDMI1', name: 'HDMI 1' },
            { id: 'HDMI2', name: 'HDMI 2' },
            { id: 'HDMI3', name: 'HDMI 3 (Chromecast)' },
            { id: 'TV',    name: 'TV' },
        ];
    }
}
