import http from 'http';
import dgram from 'dgram';
import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';

const TOKEN_FILE = path.resolve(process.cwd(), 'data/samsung-tv-token.json');

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
}

// ── Controller ────────────────────────────────────────────────────────────────

export class TvController {
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
                    await new Promise(r => setTimeout(r, 150));
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
                if (!done) { done = true; reject(new Error(`TV WebSocket error: ${String(e)}`)); }
            });

            // Safety timeout
            setTimeout(() => {
                if (!done) { done = true; ws.close(); resolve(); }
            }, 8000);
        });
    }

    async powerOn(): Promise<string> {
        if (!this.mac) throw new Error('No MAC address configured — cannot power on TV');
        if (await this.isOn()) {
            await this.sendKeys(['KEY_HDMI3']);
            return 'TV already on — switched to HDMI3.';
        }
        await sendWol(this.mac, this.tvIp);
        Logger.info(`WoL sent to ${this.mac}`);
        // Wait for TV to boot
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 3000));
            if (await this.isOn()) {
                await new Promise(r => setTimeout(r, 1500));
                await this.sendKeys(['KEY_HDMI3']);
                return 'TV powered on and set to HDMI3.';
            }
        }
        return 'TV WoL sent — waiting for boot (switch to HDMI3 manually if needed).';
    }

    /**
     * Power off the TV. Tries KEY_POWEROFF first, falls back to KEY_POWER toggle.
     * No-op if TV is already off.
     */
    async powerOff(): Promise<string> {
        if (!(await this.isOn())) return 'TV already off.';
        await this.sendKeys(['KEY_POWEROFF']);
        // Give TV 2s to react
        await new Promise(r => setTimeout(r, 2000));
        if (await this.isOn()) {
            // KEY_POWEROFF didn't work — try toggle
            Logger.warn('KEY_POWEROFF had no effect, trying KEY_POWER toggle');
            await this.sendKeys(['KEY_POWER']);
        }
        return 'TV turned off.';
    }

    async setVolume(level: number): Promise<void> {
        const target = Math.max(0, Math.min(100, Math.round(level)));
        const keys = [
            ...Array(50).fill('KEY_VOLDOWN'),
            ...Array(target).fill('KEY_VOLUP'),
        ];
        await this.sendKeys(keys);
    }

    async mute(): Promise<void> { await this.sendKeys(['KEY_MUTE']); }
}
