import dgram from 'dgram';
import Logger from './logger';

/**
 * Govee LAN API client (UDP) — protocol documented at
 * https://app-h5.govee.com/user-manual/wlan-guide
 *
 * - Commands → device IP:4003
 * - Status responses → bound port (default 4002)
 *
 * Requires "LAN Control" enabled in the Govee Home app for that device.
 */
interface GoveeMsg<T = unknown> {
    msg: { cmd: string; data: T };
}

const CMD_PORT = 4003;

function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) throw new Error(`Invalid hex color: ${hex}`);
    return {
        r: parseInt(m[1], 16),
        g: parseInt(m[2], 16),
        b: parseInt(m[3], 16),
    };
}

export default class GoveeClient {
    constructor(public readonly ip: string, public readonly name: string) {}

    private async send(msg: GoveeMsg): Promise<void> {
        return new Promise((resolve, reject) => {
            const buf = Buffer.from(JSON.stringify(msg));
            const sock = dgram.createSocket('udp4');
            sock.send(buf, 0, buf.length, CMD_PORT, this.ip, (err) => {
                sock.close();
                if (err) {
                    Logger.warn(
                        `[govee ${this.name}] send failed: ${err.message}`,
                    );
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    public on(value: boolean): Promise<void> {
        return this.send({
            msg: { cmd: 'turn', data: { value: value ? 1 : 0 } },
        });
    }

    /** brightness 0–100 (Govee uses 0–100 natively) */
    public brightness(value: number): Promise<void> {
        const clamped = Math.max(0, Math.min(100, Math.round(value)));
        return this.send({
            msg: { cmd: 'brightness', data: { value: clamped } },
        });
    }

    /**
     * Set RGB color. `colorTemInKelvin: 0` forces the lamp into RGB mode
     * (otherwise some firmwares keep the previous white temperature).
     */
    public color(hex: string): Promise<void> {
        const color = hexToRgb(hex);
        return this.send({
            msg: {
                cmd: 'colorwc',
                data: { color, colorTemInKelvin: 0 },
            },
        });
    }
}
