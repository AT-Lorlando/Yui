/**
 * TvPrep — prepare Samsung TV for Chromecast playback.
 *
 * Mirrors the logic in mcp-samsung's SamsungController.prepareChromecast().
 * Called automatically by playOnSpeaker() when the target speaker is the
 * Chromecast device, so the LLM never needs to call tv_prepare_chromecast
 * before Spotify playback.
 */

import axios from 'axios';
import dgram from 'dgram';
import Logger from './logger';

const SMARTTHINGS_BASE = 'https://api.smartthings.com/v1';

// These come from the same .env already loaded by index.ts
const token    = process.env.SMARTTHINGS_TOKEN;
const deviceId = process.env.SMARTTHINGS_TV_DEVICE_ID;
const mac      = process.env.SMARTTHINGS_TV_MAC;
const tvIp     = process.env.SMARTTHINGS_TV_IP;

/** Name of the Spotify Connect device that routes audio through the Chromecast. */
const CHROMECAST_SPEAKER = (
    process.env.SPOTIFY_SEEDER_DEVICE ?? 'Chromecaste'
).toLowerCase();

function sendWol(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!mac || !tvIp) { resolve(); return; }
        const hex = mac.replace(/[:\-]/g, '');
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

async function isOn(client: ReturnType<typeof axios.create>): Promise<boolean> {
    try {
        const probe = await client.post(`/devices/${deviceId}/commands`, {
            commands: [{ component: 'main', capability: 'refresh', command: 'refresh' }],
        });
        return probe.data?.results?.some((r: any) => r.status !== 'FAILED') ?? false;
    } catch {
        return false;
    }
}

async function setHdmi3(client: ReturnType<typeof axios.create>): Promise<void> {
    await client.post(`/devices/${deviceId}/commands`, {
        commands: [{
            component: 'main',
            capability: 'samsungvd.mediaInputSource',
            command: 'setInputSource',
            arguments: ['HDMI3'],
        }],
    });
}

/**
 * Ensure the TV is on and set to HDMI3 (Chromecast input).
 * No-op if SmartThings is not configured. Never throws.
 */
export async function prepareTvForChromecast(): Promise<void> {
    if (!token || !deviceId) return;

    const client = axios.create({
        baseURL: SMARTTHINGS_BASE,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    try {
        if (await isOn(client)) {
            await setHdmi3(client);
            Logger.info('TvPrep: TV already on — switched to HDMI3');
            return;
        }

        Logger.info('TvPrep: TV off — sending WoL...');
        await sendWol();

        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 3000));
            if (await isOn(client)) {
                await setHdmi3(client);
                Logger.info('TvPrep: TV powered on — HDMI3');
                return;
            }
        }
        Logger.warn('TvPrep: TV WoL sent but did not respond in time');
    } catch (err) {
        Logger.warn(`TvPrep: error during TV preparation — ${err}`);
    }
}

/**
 * Returns true if the given speaker name targets the Chromecast.
 * Used by playOnSpeaker() to decide whether to trigger TV prep.
 */
export function isChromecastSpeaker(name: string | undefined): boolean {
    return !!name && name.toLowerCase() === CHROMECAST_SPEAKER;
}
