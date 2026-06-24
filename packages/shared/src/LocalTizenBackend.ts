import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import { dataPath } from './dataPaths';
import { wakeOnLan } from './wakeOnLan';
import type { TvBackend, TvStatus } from './TvBackend';

const TOKEN_FILE = dataPath('samsung-tv-token.json');

function loadToken(): string | null {
    try {
        if (fs.existsSync(TOKEN_FILE))
            return (
                JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')).token ?? null
            );
    } catch {
        /* ignore */
    }
    return null;
}

function saveToken(token: string): void {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }), { mode: 0o600 });
}

/** Contrôle TV local : WoL + WebSocket télécommande Tizen (wss://:8002). */
export class LocalTizenBackend implements TvBackend {
    constructor(private tvIp: string, private mac?: string) {}

    /** Plancher à 50 VOLDOWN puis remonte à `level` (volume absolu). */
    static volumeKeys(level: number): string[] {
        const target = Math.max(0, Math.min(100, Math.round(level)));
        return [
            ...Array(50).fill('KEY_VOLDOWN'),
            ...Array(target).fill('KEY_VOLUP'),
        ];
    }

    async isOn(): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get(
                `http://${this.tvIp}:8001/api/v2/`,
                { timeout: 2500 },
                (res) => {
                    if (res.statusCode !== 200) {
                        res.resume();
                        resolve(false);
                        return;
                    }
                    let body = '';
                    res.on('data', (c) => (body += c));
                    res.on('end', () => {
                        try {
                            const state =
                                JSON.parse(body)?.device?.PowerState ?? 'on';
                            resolve(state === 'on');
                        } catch {
                            resolve(false);
                        }
                    });
                },
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
        });
    }

    private sendKeys(keys: string[], msPerKey = 150): Promise<void> {
        if (keys.length === 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const appName = Buffer.from('Yui').toString('base64');
            const token = loadToken();
            const url =
                `wss://${this.tvIp}:8002/api/v2/channels/samsung.remote.control` +
                `?name=${appName}${token ? `&token=${token}` : ''}`;
            const ws = new WebSocket(url, { rejectUnauthorized: false });
            let done = false;

            ws.on('open', async () => {
                for (const key of keys) {
                    ws.send(
                        JSON.stringify({
                            method: 'ms.remote.control',
                            params: {
                                Cmd: 'Click',
                                DataOfCmd: key,
                                TypeOfRemote: 'SendRemoteKey',
                            },
                        }),
                    );
                    await new Promise((r) => setTimeout(r, msPerKey));
                }
                await new Promise((r) => setTimeout(r, 300));
                if (!done) {
                    done = true;
                    resolve();
                }
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
            });
            ws.on('message', (data: Buffer) => {
                try {
                    const t = JSON.parse(data.toString())?.data?.token;
                    if (t) saveToken(String(t));
                } catch {
                    /* ignore */
                }
            });
            ws.on('error', () => {
                if (!done) {
                    done = true;
                    reject(new Error('TV WebSocket connection failed'));
                }
            });
            setTimeout(() => {
                if (!done) {
                    done = true;
                    resolve();
                    try {
                        ws.close();
                    } catch {
                        /* ignore */
                    }
                }
            }, 8000);
        });
    }

    async ensureOn(): Promise<string> {
        if (!this.mac)
            throw new Error('No MAC address configured — cannot power on TV');
        if (await this.isOn()) {
            await this.sendKeys(['KEY_HDMI3']);
            return 'TV déjà allumée — basculée sur HDMI3.';
        }
        await wakeOnLan(this.mac, this.tvIp);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 3000));
            if (await this.isOn()) {
                await new Promise((r) => setTimeout(r, 1500));
                await this.sendKeys(['KEY_HDMI3']);
                return 'TV allumée et basculée sur HDMI3.';
            }
        }
        return 'TV allumée (WoL envoyé) — bascule HDMI3 manuelle si besoin.';
    }

    async powerOff(): Promise<string> {
        if (!(await this.isOn())) return 'La télé est déjà éteinte.';
        await this.sendKeys(['KEY_POWER']);
        return 'Télé éteinte.';
    }

    async setVolume(level: number): Promise<void> {
        await this.sendKeys(LocalTizenBackend.volumeKeys(level));
    }

    async setMute(_mute: boolean): Promise<void> {
        await this.sendKeys(['KEY_MUTE']); // KEY_MUTE est un toggle
    }

    async setInput(source: string): Promise<void> {
        await this.sendKeys([`KEY_${source.toUpperCase()}`]);
    }

    async status(): Promise<TvStatus> {
        return { power: (await this.isOn()) ? 'on' : 'off' };
    }
}
