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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adbShell(args: string[], timeout?: number): Promise<string> {
    return execAdb(['-s', ATV_ADB_HOST, 'shell', ...args], timeout);
}

/** Connexion idempotente — adb garde le device ensuite. */
async function adbConnect(): Promise<void> {
    const out = await execAdb(['connect', ATV_ADB_HOST], 8_000);
    if (/failed|refused|unable/i.test(out)) {
        throw new Error(`adb connect: ${out}`);
    }
}

async function adbIsAwake(): Promise<boolean> {
    const out = await adbShell(['dumpsys', 'power'], 8_000);
    return /mWakefulness=Awake/.test(out);
}

/** Package de l'activité au premier plan (best-effort, '' si illisible). */
async function foregroundPackage(): Promise<string> {
    try {
        const out = await adbShell(
            ['dumpsys', 'activity', 'activities'],
            8_000,
        );
        return (
            /(?:topResumedActivity|mResumedActivity)[^\n]*?\s([\w.]+)\//.exec(
                out,
            )?.[1] ?? ''
        );
    } catch {
        return '';
    }
}

/**
 * Shield prêt à recevoir un intent : connecté ET réveillé. Vécu : un deep-link
 * envoyé pendant que le Shield sort de veille part dans le vide (Prime/Fully
 * « ne se lancent pas ») — le premier `adb connect` après la veille réseau
 * échoue parfois aussi. Donc : connect avec retries, WAKEUP si endormi, et on
 * ATTEND que l'appareil se dise réveillé avant de lancer quoi que ce soit.
 */
async function ensureShieldReady(): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
        try {
            await adbConnect();
            lastErr = undefined;
            break;
        } catch (e) {
            lastErr = e;
            await sleep(1_200);
        }
    }
    if (lastErr) throw lastErr;
    // « connected » ne veut pas dire autorisé : si la clé RSA du serveur adb
    // n'est pas acceptée par le Shield, TOUT shell échoue en « device
    // unauthorized » (vécu 08/09 : dev et prod partagent le serveur adb de la
    // machine — port 5037, premier utilisateur servi — et sa clé avait été
    // révoquée : plus aucun lancement Prime/Fully). Erreur claire plutôt
    // qu'un échec silencieux par commande.
    try {
        await execAdb(['-s', ATV_ADB_HOST, 'get-state'], 8_000);
    } catch (e) {
        if (/unauthorized/i.test(String(e))) {
            throw new Error(
                'Shield ADB non autorisé — accepter « Toujours autoriser » ' +
                    'dans la boîte de dialogue sur le Shield (elle apparaît ' +
                    'à la prochaine connexion, écran allumé)',
            );
        }
        throw e;
    }
    try {
        if (await adbIsAwake()) return;
        Logger.info('Shield endormi — WAKEUP + attente du réveil');
        await adbShell(['input', 'keyevent', '224']); // KEYCODE_WAKEUP
        for (let i = 0; i < 10; i++) {
            await sleep(700);
            if (await adbIsAwake()) break;
        }
        // Petite marge : le launcher se pose avant de recevoir l'intent.
        await sleep(800);
    } catch (e) {
        // Best-effort : un dumpsys illisible ne doit pas empêcher le lancement.
        Logger.warn(`ensureShieldReady: ${e}`);
    }
}

async function adbLaunch(target: string, pkg?: string): Promise<string> {
    await ensureShieldReady();
    // Épingler le package est indispensable pour les liens que l'app link ne
    // couvre pas (ex. primevideo /watch) : sans lui, `am start` résout sur le
    // launcher et il ne se passe rien.
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
              ...(pkg ? [pkg] : []),
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
    const wanted = pkg ?? (target.startsWith('http') ? '' : target);
    for (let attempt = 0; attempt < 3; attempt++) {
        const out = await execAdb(args);
        // `am start` sort en 0 même sur échec — l'erreur est dans la sortie.
        if (/^Error|Exception|No activities found/im.test(out)) {
            throw new Error(`adb launch: ${out.slice(0, 200)}`);
        }
        if (!wanted) {
            Logger.debug(`adb launch OK: ${target}`);
            return `Lancé via ADB : ${target}`;
        }
        // Vérifier que l'app passe VRAIMENT au premier plan : au sortir de
        // veille, un intent accepté peut quand même se perdre (launcher pas
        // prêt) — c'était le « Prime ne se lance pas » des lancements à froid.
        for (let i = 0; i < 5; i++) {
            await sleep(900);
            if ((await foregroundPackage()).startsWith(wanted)) {
                Logger.debug(`adb launch OK: ${target}`);
                return `Lancé via ADB : ${target}`;
            }
        }
        Logger.warn(
            `adb launch: ${wanted} pas au premier plan — relance (${
                attempt + 1
            })`,
        );
    }
    throw new Error(`adb launch: ${wanted} n'est pas passé au premier plan`);
}

/** Touches média Android (KEYCODE_*) — pilotent l'app au premier plan. */
const MEDIA_KEYCODES: Record<string, number> = {
    play_pause: 85,
    play: 126,
    pause: 127,
    stop: 86,
    rewind: 89,
    forward: 90,
};

async function sendMediaKey(action: string): Promise<string> {
    const code = MEDIA_KEYCODES[action];
    if (code === undefined) throw new Error(`Action inconnue : ${action}`);
    if (!ATV_ADB_HOST) throw new Error('ATV_ADB_HOST non configuré');
    await adbConnect();
    await adbShell(['input', 'keyevent', String(code)]);
    Logger.info(`Shield media key: ${action}`);
    return `TV : ${action.replace('_', '/')}`;
}

/**
 * Prime démarré à froid s'arrête sur « Qui regarde ? » et garde le deep-link
 * en attente. Son UI n'expose rien à l'accessibilité (uiautomator vide) — on
 * détecte le blocage via la media session : si rien ne joue quelques secondes
 * après le lancement, un OK sélectionne le premier profil (le nôtre).
 * Best-effort : ne jette jamais.
 */
async function primePlaybackState(): Promise<string | undefined> {
    const dump = await execAdb([
        '-s',
        ATV_ADB_HOST,
        'shell',
        'dumpsys',
        'media_session',
    ]);
    const at = dump.indexOf(`package=${PRIME_PACKAGE}`);
    return /state=PlaybackState \{state=(\d+)/.exec(
        at >= 0 ? dump.slice(at, at + 1_500) : '',
    )?.[1];
}

async function nudgePrimeProfile(): Promise<void> {
    if (!ATV_ADB_HOST) return;
    try {
        // Premier essai à 1 s (démarrage tiède : le picker est déjà là), puis
        // toutes les 2 s — à froid il apparaît après quelques secondes et un
        // appui trop tôt part dans le vide. On s'arrête dès que ça joue ;
        // sur écran de chargement l'OK est sans effet.
        for (let attempt = 0; attempt < 4; attempt++) {
            await new Promise((r) =>
                setTimeout(r, attempt === 0 ? 1_000 : 2_000),
            );
            const state = await primePlaybackState();
            if (state === '3') return;
            // Jamais d'OK à l'aveugle : si Prime n'est pas au premier plan
            // (Shield en plein réveil, lancement via le repli ATV), l'appui
            // partirait dans le launcher et ouvrirait n'importe quoi.
            if (!(await foregroundPackage()).startsWith(PRIME_PACKAGE)) {
                continue;
            }
            Logger.info(
                `Prime pas en lecture (state=${state ?? '?'}) — OK profil (${
                    attempt + 1
                })`,
            );
            await execAdb([
                '-s',
                ATV_ADB_HOST,
                'shell',
                'input',
                'keyevent',
                '23',
            ]);
        }
    } catch (e) {
        Logger.warn(`nudgePrimeProfile: ${e}`);
    }
}

/** ADB si configuré, sinon (ou en cas d'échec ADB) Android TV Remote. */
async function launchOnTv(
    target: string,
    expectedPkg: string,
): Promise<string> {
    if (ATV_ADB_HOST) {
        try {
            return await adbLaunch(target, expectedPkg);
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
        // JustWatch donne la fiche (`/detail`) : Prime y met en avant S1E1.
        // `/watch` sur le même GTI lance la lecture avec la reprise Amazon
        // (l'épisode en cours du profil) — c'est le comportement voulu.
        if (link) link = link.replace('/detail?', '/watch?');
        const [, result] = await Promise.all([
            prep,
            launchOnTv(link || PRIME_PACKAGE, PRIME_PACKAGE),
        ]);
        // À froid, Prime bloque sur le choix de profil — débloqué en tâche de
        // fond pour ne pas retarder la réponse.
        void nudgePrimeProfile();
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
    tvMediaKey(action: string): Promise<string> {
        return sendMediaKey(action);
    }

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
