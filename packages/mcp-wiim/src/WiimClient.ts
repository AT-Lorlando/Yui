import https from 'https';
import Logger from './logger';

/**
 * Client de l'API HTTP locale Linkplay du WiiM (https://<ip>/httpapi.asp).
 *
 * Contrairement à l'API Spotify, ce contrôle est **local et universel** : le
 * volume et le transport marchent quelle que soit la source (Spotify Connect,
 * Tidal Connect, Bluetooth, radio…), en ~10 ms et sans quota. Cert
 * auto-signé → rejectUnauthorized: false, comme le bridge Hue.
 *
 * Doc : https://www.wiimhome.com/pdf/HTTP%20API%20for%20WiiM%20Products.pdf
 */

export interface WiimStatus {
    /** play | pause | stop | load | none (idle) */
    status: string;
    playing: boolean;
    volume: number;
    muted: boolean;
    title?: string;
    artist?: string;
    /** Source décodée (spotify, bluetooth, tidal, dlna…) si connue. */
    source?: string;
    /** Mode Linkplay brut (diagnostic : une source inconnue s'y lit). */
    mode?: string;
    album?: string;
    /** Pochette (getMetaInfo), si l'enceinte la connaît. */
    art?: string;
    /**
     * Qui pilote la lecture : `spotify` (Spotify Connect — l'API Spotify voit
     * tout), `wiim` (cast, AirPlay, Bluetooth… — seule l'enceinte sait),
     * `idle` (rien en cours).
     */
    controller: 'spotify' | 'wiim' | 'idle';
}

/** Mode Linkplay de Spotify Connect. */
export const SPOTIFY_MODE = '31';

/**
 * Pur : qui pilote. Spotify Connect → l'API Spotify (synchro garantie) ;
 * toute autre source en lecture ou en pause → l'enceinte ; sinon rien.
 */
export function controllerFor(
    mode: string | undefined,
    status: string,
): WiimStatus['controller'] {
    if (mode === SPOTIFY_MODE) return 'spotify';
    if (status === 'play' || status === 'pause' || status === 'load') {
        return mode && mode !== '0' ? 'wiim' : 'idle';
    }
    return 'idle';
}

/** Pur : getPlayerStatus (+ getMetaInfo facultatif) → WiimStatus. */
export function parseStatus(raw: any, meta?: any): WiimStatus {
    const status = String(raw?.status ?? 'none');
    const mode = raw?.mode !== undefined ? String(raw.mode) : undefined;
    const m = meta?.metaData ?? {};
    const clean = (v: unknown) => {
        const t = typeof v === 'string' ? v.trim() : '';
        return t &&
            t.toLowerCase() !== 'unknow' &&
            t.toLowerCase() !== 'unknown'
            ? t
            : undefined;
    };
    const art = clean(m.albumArtURI);
    return {
        status,
        playing: status === 'play',
        volume: Number(raw?.vol ?? 0),
        muted: raw?.mute === '1',
        title: decodeHexMeta(raw?.Title) ?? clean(m.title),
        artist: decodeHexMeta(raw?.Artist) ?? clean(m.artist),
        album: decodeHexMeta(raw?.Album) ?? clean(m.album),
        ...(art && /^https?:\/\//.test(art) ? { art } : {}),
        source: mode ? MODES[mode] : undefined,
        mode,
        controller: controllerFor(mode, status),
    };
}

/** Les métadonnées Linkplay sont hex-encodées ("556E..." → "Un…"). */
export function decodeHexMeta(raw: string | undefined): string | undefined {
    if (!raw || !/^[0-9A-Fa-f]+$/.test(raw) || raw.length % 2 !== 0) {
        return raw || undefined;
    }
    try {
        const text = Buffer.from(raw, 'hex').toString('utf8');
        // Un faux positif hex (ex. "CAFE") produirait du binaire — on garde le
        // décodé seulement s'il est imprimable.
        if (/[\x00-\x08\x0e-\x1f]/.test(text)) return raw;
        return text === 'Unknown' ? undefined : text;
    } catch {
        return raw;
    }
}

/** mode Linkplay → nom de source lisible (sous-ensemble utile). */
const MODES: Record<string, string> = {
    '31': 'spotify',
    '32': 'tidal',
    '40': 'aux',
    '41': 'bluetooth',
    '43': 'optical',
    '10': 'réseau',
    '1': 'airplay',
    '2': 'dlna',
    '36': 'qobuz',
    '49': 'hdmi',
    '51': 'usb',
    '99': 'multiroom',
};

export class WiimClient {
    constructor(public readonly ip: string) {}

    private request(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = https.get(
                {
                    host: this.ip,
                    path: `/httpapi.asp?command=${encodeURIComponent(command)}`,
                    rejectUnauthorized: false,
                    timeout: 5000,
                },
                (res) => {
                    let buf = '';
                    res.on('data', (c) => (buf += c));
                    res.on('end', () => resolve(buf));
                },
            );
            req.on('timeout', () => {
                req.destroy(new Error('WiiM timeout'));
            });
            req.on('error', reject);
        });
    }

    async getStatus(): Promise<WiimStatus> {
        const raw = JSON.parse(await this.request('getPlayerStatus'));
        // Métadonnées complètes (pochette, et titre quand getPlayerStatus
        // n'en a pas — fréquent en cast) : best-effort, jamais bloquant.
        let meta: any;
        if (raw?.status === 'play' || raw?.status === 'pause') {
            try {
                meta = JSON.parse(await this.request('getMetaInfo'));
            } catch {
                meta = undefined;
            }
        }
        return parseStatus(raw, meta);
    }

    async setVolume(percent: number): Promise<void> {
        const v = Math.max(0, Math.min(100, Math.round(percent)));
        await this.request(`setPlayerCmd:vol:${v}`);
        Logger.info(`[wiim] volume → ${v}%`);
    }

    /** pause | resume | onepause (toggle) | stop | prev | next */
    async playerCmd(cmd: string): Promise<void> {
        await this.request(`setPlayerCmd:${cmd}`);
        Logger.info(`[wiim] ${cmd}`);
    }

    async setMute(mute: boolean): Promise<void> {
        await this.request(`setPlayerCmd:mute:${mute ? 1 : 0}`);
    }

    /** Rappelle un preset WiiM Home (1-12) — station, playlist, album… */
    async recallPreset(n: number): Promise<void> {
        await this.request(`MCUKeyShortClick:${n}`);
        Logger.info(`[wiim] preset ${n}`);
    }
}
