import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from './logger';

const CAST_SCRIPT = path.join(__dirname, '..', 'cast.py');
const ATV_SCRIPT = path.join(__dirname, '..', 'atv_launch.py');
const HOST = process.env.CHROMECAST_HOST ?? '10.0.0.140';
const PORT = String(process.env.CHROMECAST_PORT ?? '8009');
// Fully tourne sur la Google TV (= même appareil que le Chromecast). On la lance
// via le protocole Android TV Remote (cert/clé appairés une fois), pas via ADB
// ni le Remote Admin PLUS payant de Fully.
const FULLY_PACKAGE = process.env.FULLY_PACKAGE ?? 'de.ozerov.fully';

function run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'python3',
            [CAST_SCRIPT, HOST, PORT, ...args],
            { timeout: 40_000 },
            (error, stdout, stderr) => {
                if (error) {
                    Logger.error(`cast.py stderr: ${stderr}`);
                    reject(new Error(stderr?.trim() || error.message));
                } else {
                    Logger.debug(`cast.py: ${stdout.trim()}`);
                    resolve(stdout.trim());
                }
            },
        );
    });
}

// Lance atv_launch.py <host> <cert> <key> <package> (Android TV Remote v2).
function runAtv(pkg: string): Promise<string> {
    const cert = dataPath('atv-cert.pem');
    const key = dataPath('atv-key.pem');
    return new Promise((resolve, reject) => {
        execFile(
            'python3',
            [ATV_SCRIPT, HOST, cert, key, pkg],
            { timeout: 30_000 },
            (error, stdout, stderr) => {
                if (error) {
                    Logger.error(`atv_launch.py stderr: ${stderr}`);
                    reject(new Error(stderr?.trim() || error.message));
                } else {
                    Logger.debug(`atv_launch.py: ${stdout.trim()}`);
                    resolve(stdout.trim());
                }
            },
        );
    });
}

// ── Media helpers ─────────────────────────────────────────────────────────────

const MEDIA_DIR = path.resolve(
    process.cwd(),
    process.env.MEDIA_DIR ?? 'assets/media',
);
const MEDIA_BASE_URL =
    `http://${process.env.HOST}:${process.env.PORT}/media`.replace(/\/$/, '');

const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp|avif)$/i;
const VIDEO_EXT = /\.(mp4|mkv|mov|avi|webm|m4v)$/i;

function listMediaDir(subdir: string, pattern: RegExp): string[] {
    const dir = path.join(MEDIA_DIR, subdir);
    try {
        return fs
            .readdirSync(dir)
            .filter((f) => pattern.test(f))
            .sort();
    } catch {
        return [];
    }
}

function resolveMediaFile(
    subdir: string,
    pattern: RegExp,
    file?: string,
    loop = false,
): string {
    const files = listMediaDir(subdir, pattern);
    if (files.length === 0)
        throw new Error(`Aucun fichier dans assets/media/${subdir}/`);
    const chosen = file
        ? files.includes(file)
            ? file
            : (() => {
                  throw new Error(`Fichier introuvable: ${file}`);
              })()
        : files[Math.floor(Math.random() * files.length)];
    if (loop) {
        // Serve as /media/loop/<subdir>/<stem>.mp4 so cast.py uses video/mp4 content-type
        const stem = chosen.replace(/\.[^.]+$/, '');
        return `${MEDIA_BASE_URL}/loop/${subdir}/${encodeURIComponent(
            stem,
        )}.mp4`;
    }
    return `${MEDIA_BASE_URL}/${subdir}/${encodeURIComponent(chosen)}`;
}

export function listMediaFiles(
    type: 'wallpaper' | 'video' | 'all' = 'all',
): object {
    const wallpapers =
        type !== 'video' ? listMediaDir('wallpapers', IMAGE_EXT) : [];
    const videos =
        type !== 'wallpaper' ? listMediaDir('videos', VIDEO_EXT) : [];
    return {
        wallpapers: wallpapers.map((f) => ({
            file: f,
            url: `${MEDIA_BASE_URL}/wallpapers/${encodeURIComponent(f)}`,
        })),
        videos: videos.map((f) => ({
            file: f,
            url: `${MEDIA_BASE_URL}/videos/${encodeURIComponent(f)}`,
        })),
        total: wallpapers.length + videos.length,
    };
}

// ── ChromecastController ───────────────────────────────────────────────────────

export class ChromecastController {
    castYoutube(source?: string): Promise<string> {
        Logger.info(
            `Chromecast: youtube${source ? ` "${source}"` : ' (browse)'}`,
        );
        return source ? run(['youtube', source]) : run(['youtube']);
    }

    castNetflix(title?: string): Promise<string> {
        Logger.info(`Chromecast: netflix${title ? ` "${title}"` : ''}`);
        return title ? run(['netflix', title]) : run(['netflix']);
    }

    castCrunchyroll(title?: string): Promise<string> {
        Logger.info(`Chromecast: crunchyroll${title ? ` "${title}"` : ''}`);
        return title ? run(['crunchyroll', title]) : run(['crunchyroll']);
    }

    castDisney(title?: string): Promise<string> {
        Logger.info(`Chromecast: disney${title ? ` "${title}"` : ''}`);
        return title ? run(['disney', title]) : run(['disney']);
    }

    castPrime(title?: string): Promise<string> {
        Logger.info(`Chromecast: prime${title ? ` "${title}"` : ''}`);
        return title ? run(['prime', title]) : run(['prime']);
    }

    async findShow(title: string): Promise<{
        platform: string | null;
        id: string | null;
        title: string | null;
    }> {
        Logger.info(`Chromecast: find_show "${title}"`);
        const out = await run(['find', title]);
        const lastLine =
            out
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .pop() ?? '{}';
        return JSON.parse(lastLine);
    }

    async rememberShow(
        title: string,
        platform: string,
    ): Promise<{ service: string; id: string | null; title: string }> {
        Logger.info(`Chromecast: remember_show "${title}" → ${platform}`);
        const out = await run(['remember', title, platform]);
        const lastLine =
            out
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .pop() ?? '{}';
        return JSON.parse(lastLine);
    }

    castMedia(url: string): Promise<string> {
        Logger.info(`Chromecast: media ${url}`);
        return run(['media', url]);
    }

    castStop(): Promise<string> {
        Logger.info('Chromecast: stop');
        return run(['stop']);
    }

    // Lance l'app Fully Kiosk sur la Google TV (affiche le dashboard).
    launchFully(): Promise<string> {
        Logger.info(`Chromecast: launch Fully (${FULLY_PACKAGE})`);
        return runAtv(FULLY_PACKAGE);
    }

    // ── Media library ──────────────────────────────────────────────────────────

    castWallpaper(file?: string): Promise<string> {
        // loop=true → served as infinite MP4 stream so Chromecast keeps displaying it
        const url = resolveMediaFile('wallpapers', IMAGE_EXT, file, true);
        Logger.info(`Chromecast: wallpaper ${url}`);
        return run(['media', url]);
    }

    castVideo(file?: string): Promise<string> {
        const url = resolveMediaFile('videos', VIDEO_EXT, file);
        Logger.info(`Chromecast: video ${url}`);
        return run(['media', url]);
    }
}
