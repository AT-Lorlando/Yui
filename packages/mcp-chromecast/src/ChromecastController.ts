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
const PRIME_PACKAGE =
    process.env.PRIME_PACKAGE ?? 'com.amazon.amazonvideo.livingroom';

// ── Lancement d'apps sur l'Android TV ────────────────────────────────────────
// Deux transports, du plus fiable au moins fiable :
//   1. ADB réseau (ATV_ADB_HOST, ex "10.0.0.190:5555" — Shield) : déterministe,
//      vrai code retour, deep-link n'importe quelle app.
//   2. Android TV Remote v2 (runAtv) : repli — le protocole marche partout mais
//      le dongle Google TV s'est mis à ignorer silencieusement les lancements.
const ADB_BIN = process.env.ADB_BIN ?? 'adb';
const ATV_ADB_HOST = process.env.ATV_ADB_HOST ?? '';

function execAdb(args: string[], timeout = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(ADB_BIN, args, { timeout }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr?.trim() || error.message));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

/** Connexion idempotente — adb garde le device ensuite. */
async function adbConnect(): Promise<void> {
    const out = await execAdb(['connect', ATV_ADB_HOST], 8_000);
    if (/failed|refused|unable/i.test(out)) {
        throw new Error(`adb connect: ${out}`);
    }
}

async function adbLaunch(target: string): Promise<string> {
    await adbConnect();
    const args = target.startsWith('http')
        ? [
              '-s',
              ATV_ADB_HOST,
              'shell',
              'am',
              'start',
              '-a',
              'android.intent.action.VIEW',
              '-d',
              target,
          ]
        : [
              '-s',
              ATV_ADB_HOST,
              'shell',
              'monkey',
              '-p',
              target,
              '-c',
              'android.intent.category.LAUNCHER',
              '1',
          ];
    const out = await execAdb(args);
    // `am start` sort en 0 même sur échec — l'erreur est dans la sortie.
    if (/^Error|Exception|No activities found/im.test(out)) {
        throw new Error(`adb launch: ${out.slice(0, 200)}`);
    }
    Logger.debug(`adb launch OK: ${target}`);
    return `Lancé via ADB : ${target}`;
}

/** ADB si configuré, sinon (ou en cas d'échec ADB) Android TV Remote. */
async function launchOnTv(
    target: string,
    expectedPkg: string,
): Promise<string> {
    if (ATV_ADB_HOST) {
        try {
            return await adbLaunch(target);
        } catch (e) {
            Logger.warn(
                `ADB launch failed (${e}) — fallback Android TV Remote`,
            );
        }
    }
    return runAtv(target, expectedPkg);
}

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

// Lance atv_launch.py <host> <cert> <key> <package|url> [pkg attendu]
// (Android TV Remote v2). La cible peut être un app link https:// — Android
// résout l'intent (deep-link Prime, etc.).
function runAtv(target: string, expectedPkg?: string): Promise<string> {
    const cert = dataPath('atv-cert.pem');
    const key = dataPath('atv-key.pem');
    return new Promise((resolve, reject) => {
        execFile(
            'python3',
            [
                ATV_SCRIPT,
                HOST,
                cert,
                key,
                target,
                ...(expectedPkg ? [expectedPkg] : []),
            ],
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

/** Bare file names on disk — used to build the tool schema enums. */
export function mediaFileNames(): { wallpapers: string[]; videos: string[] } {
    return {
        wallpapers: listMediaDir('wallpapers', IMAGE_EXT),
        videos: listMediaDir('videos', VIDEO_EXT),
    };
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

    async castPrime(title?: string): Promise<string> {
        // La Google TV n'expose pas Prime en DIAL (404) et son app_id Cast SDK
        // est mort — le chemin qui marche est Android TV Remote, le même que
        // Fully. Avec titre : deep-link app.primevideo.com résolu via
        // JustWatch, qu'Android ouvre directement sur la fiche.
        Logger.info(`Chromecast: prime${title ? ` "${title}"` : ''} (ATV)`);
        // TV on + entrée HDMI en parallèle de la résolution du lien.
        const prep = run(['prep']).catch(() => {});
        let link = '';
        if (title) {
            const out = await run(['link', 'prime', title]).catch(() => '');
            const last =
                out
                    .split('\n')
                    .map((l) => l.trim())
                    .filter((l) => l.startsWith('LINK:'))
                    .pop() ?? 'LINK:';
            link = last.slice(5);
        }
        const [, result] = await Promise.all([
            prep,
            launchOnTv(link || PRIME_PACKAGE, PRIME_PACKAGE),
        ]);
        return result;
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
    async launchFully(): Promise<string> {
        Logger.info(`Chromecast: launch Fully (${FULLY_PACKAGE})`);
        const [, result] = await Promise.all([
            run(['prep']).catch(() => {}),
            launchOnTv(FULLY_PACKAGE, FULLY_PACKAGE),
        ]);
        return result;
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
