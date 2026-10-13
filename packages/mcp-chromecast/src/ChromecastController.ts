import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from './logger';
import { parsePackages } from './shieldApps';

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
const MOONLIGHT_PACKAGE = process.env.MOONLIGHT_PACKAGE ?? 'com.limelight';
// Apps natives du Shield pour les cast_* historiques (13/10/2026) : la fiche
// s'ouvre dans l'app (deep-link JustWatch, comme Prime) au lieu du receiver
// Cast — repli sur le cast quand le lien manque ou qu'ADB est absent.
const NETFLIX_PACKAGE = 'com.netflix.ninja';
const YOUTUBE_PACKAGE = 'com.google.android.youtube.tv';
const CRUNCHYROLL_PACKAGE = 'com.crunchyroll.crunchyroid';
const DISNEY_PACKAGE = 'com.disney.disneyplus';

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

// Une cible « URI » (https://, crunchyroll://…) part en intent VIEW ; sinon
// c'est un package à lancer tel quel.
const isUri = (target: string): boolean =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(target);

async function adbLaunch(target: string, pkg?: string): Promise<string> {
    await ensureShieldReady();
    // Épingler le package est indispensable pour les liens que l'app link ne
    // couvre pas (ex. primevideo /watch) : sans lui, `am start` résout sur le
    // launcher et il ne se passe rien.
    const args = isUri(target)
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
    const wanted = pkg ?? (isUri(target) ? '' : target);
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
export type ShowService = 'netflix' | 'crunchyroll' | 'disney' | 'prime';
export const SHOW_SERVICES: ShowService[] = [
    'netflix',
    'crunchyroll',
    'disney',
    'prime',
];
const SHOW_PACKAGE: Record<ShowService, string> = {
    netflix: NETFLIX_PACKAGE,
    crunchyroll: CRUNCHYROLL_PACKAGE,
    disney: DISNEY_PACKAGE,
    prime: PRIME_PACKAGE,
};

/**
 * URL/URI à ouvrir dans l'app native du Shield pour un id résolu
 * (justwatch.py) — null si le service n'a pas de lien natif fiable.
 * `autoplay` : lecture directe plutôt que la fiche — honoré par Netflix
 * (`/watch` reprend où on en était) ; Prime reste sur la fiche (`/watch`
 * relançait S1E1, vécu sur Mentalist) et Crunchyroll ouvre ce que JustWatch
 * a donné (série → fiche, épisode → lecteur).
 */
export function nativeUrl(
    service: ShowService,
    id: string,
    autoplay: boolean,
): string | null {
    if (service === 'netflix')
        return `https://www.netflix.com/${autoplay ? 'watch' : 'title'}/${id}`;
    // L'app Android TV ne déclare que son schéma propre (pas d'app link
    // https). Un id d'épisode arrive préfixé `episode/` (justwatch.py) ; un
    // id nu de 9 caractères est une série, sinon un épisode (vieux caches).
    if (service === 'crunchyroll') {
        if (id.includes('/')) return `crunchyroll://${id}`;
        return /^G[A-Z0-9]{8}$/i.test(id)
            ? `crunchyroll://series/${id}`
            : `crunchyroll://episode/${id}`;
    }
    // Prime : l'id EST le deep-link de la fiche.
    if (service === 'prime') return isUri(id) ? id : null;
    return null;
}

export interface ShowHit {
    service: ShowService;
    id: string;
    title: string;
    year: number | null;
    type: 'show' | 'movie';
}

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
// (Android TV Remote v2). La cible peut être un app link https:// ou un
// schéma propre (crunchyroll://) — Android
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
    /** Packages tiers installés sur le Shield (vide sans ADB). */
    async listInstalledPackages(): Promise<string[]> {
        if (!ATV_ADB_HOST) return [];
        try {
            await adbConnect();
            const out = await adbShell(
                ['pm', 'list', 'packages', '-3'],
                10_000,
            );
            return parsePackages(out);
        } catch (e) {
            Logger.warn(`listInstalledPackages: ${e}`);
            return [];
        }
    }

    /** Ouvre une app du Shield (TV allumée + HDMI en parallèle). */
    async launchApp(pkg: string, label = pkg): Promise<string> {
        Logger.info(`Shield: launch ${label} (${pkg})`);
        const [, result] = await Promise.all([
            run(['prep']).catch(() => {}),
            launchOnTv(pkg, pkg),
        ]);
        return result;
    }

    /**
     * Service de streaming : app native du Shield d'abord (fiche du titre via
     * le lien JustWatch, ou l'app seule), cast en repli — lien introuvable
     * avec un titre, ADB absent, ou lancement raté.
     */
    private async nativeOrCast(
        service: 'netflix' | 'crunchyroll' | 'disney',
        pkg: string,
        title: string | undefined,
    ): Promise<string> {
        const castFallback = () =>
            title ? run([service, title]) : run([service]);
        if (!ATV_ADB_HOST) return castFallback();
        const toUrl = (id: string) => nativeUrl(service, id, false);
        if (title && service === 'disney') return castFallback();
        Logger.info(`Shield: ${service}${title ? ` "${title}"` : ''} (natif)`);
        const prep = run(['prep']).catch(() => {});
        let link = '';
        if (title) {
            const out = await run(['link', service, title]).catch(() => '');
            const last =
                out
                    .split('\n')
                    .map((l) => l.trim())
                    .filter((l) => l.startsWith('LINK:'))
                    .pop() ?? 'LINK:';
            const id = last.slice(5);
            link = id ? toUrl(id) ?? '' : '';
            if (!link) {
                Logger.info(
                    `Shield: pas de lien ${service} pour "${title}" → cast`,
                );
                await prep;
                return castFallback();
            }
        }
        try {
            const [, result] = await Promise.all([
                prep,
                launchOnTv(link || pkg, pkg),
            ]);
            return result;
        } catch (e) {
            Logger.warn(`Shield: ${service} natif KO (${e}) → cast`);
            return castFallback();
        }
    }

    castYoutube(source?: string): Promise<string> {
        Logger.info(
            `Chromecast: youtube${source ? ` "${source}"` : ' (browse)'}`,
        );
        if (ATV_ADB_HOST) {
            // App native sans source ; lien direct si URL/id ; recherche
            // libre → cast (le receiver sait chercher, l'app non).
            if (!source) return this.launchApp(YOUTUBE_PACKAGE, 'YouTube');
            const id =
                /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(
                    source,
                )?.[1] ?? (/^[A-Za-z0-9_-]{11}$/.test(source) ? source : '');
            if (id) {
                return (async () => {
                    const [, result] = await Promise.all([
                        run(['prep']).catch(() => {}),
                        launchOnTv(
                            `https://www.youtube.com/watch?v=${id}`,
                            YOUTUBE_PACKAGE,
                        ),
                    ]);
                    return result;
                })().catch((e) => {
                    Logger.warn(`Shield: youtube natif KO (${e}) → cast`);
                    return run(['youtube', source]);
                });
            }
        }
        return source ? run(['youtube', source]) : run(['youtube']);
    }

    castNetflix(title?: string): Promise<string> {
        return this.nativeOrCast('netflix', NETFLIX_PACKAGE, title);
    }

    castCrunchyroll(title?: string): Promise<string> {
        return this.nativeOrCast('crunchyroll', CRUNCHYROLL_PACKAGE, title);
    }

    castDisney(title?: string): Promise<string> {
        return this.nativeOrCast('disney', DISNEY_PACKAGE, title);
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
        // JustWatch donne la fiche (`/detail`). On y reste : `/watch` sur le
        // même GTI ne reprenait PAS l'épisode en cours mais relançait S1E1 à
        // chaque fois (vécu sur Mentalist) — la fiche laisse le bouton
        // « Reprendre » d'Amazon faire son travail, sans autoplay.
        const [, result] = await Promise.all([
            prep,
            launchOnTv(link || PRIME_PACKAGE, PRIME_PACKAGE),
        ]);
        // À froid, Prime bloque sur le choix de profil — débloqué en tâche de
        // fond pour ne pas retarder la réponse.
        void nudgePrimeProfile();
        return result;
    }

    /** Résultats JustWatch (titre × plateforme) pour le choix dans l'app. */
    async searchShows(query: string): Promise<ShowHit[]> {
        const q = query.trim();
        if (!q) return [];
        Logger.info(`Chromecast: search_shows "${q}"`);
        const out = await run(['search', q]);
        const lastLine =
            out
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.startsWith('['))
                .pop() ?? '[]';
        return JSON.parse(lastLine);
    }

    /**
     * Lance un titre déjà choisi (préréglage « Lancer un titre ») : app
     * native du Shield avec le lien du service, sinon cast DIAL/SDK par id.
     */
    async playShow(
        service: ShowService,
        id: string,
        title: string,
        autoplay: boolean,
    ): Promise<string> {
        const label = title || id;
        const castFallback = () => run(['launchid', service, id, label]);
        const url = ATV_ADB_HOST ? nativeUrl(service, id, autoplay) : null;
        if (!url) return castFallback();
        Logger.info(
            `Shield: ${service} "${label}" ${
                autoplay ? 'lecture' : 'fiche'
            } (natif)`,
        );
        const prep = run(['prep']).catch(() => {});
        try {
            const [, result] = await Promise.all([
                prep,
                launchOnTv(url, SHOW_PACKAGE[service]),
            ]);
            if (service === 'prime') void nudgePrimeProfile();
            return result;
        } catch (e) {
            Logger.warn(`Shield: ${service} natif KO (${e}) → cast`);
            return castFallback();
        }
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

    /** Moonlight (streaming de jeu depuis le PC) sur le Shield. */
    async launchMoonlight(): Promise<string> {
        Logger.info(`Chromecast: launch Moonlight (${MOONLIGHT_PACKAGE})`);
        const [, result] = await Promise.all([
            run(['prep']).catch(() => {}),
            launchOnTv(MOONLIGHT_PACKAGE, MOONLIGHT_PACKAGE),
        ]);
        return result;
    }

    async launchFully(): Promise<string> {
        Logger.info(`Chromecast: launch Fully (${FULLY_PACKAGE})`);
        const [, result] = await Promise.all([
            run(['prep']).catch(() => {}),
            launchOnTv(FULLY_PACKAGE, FULLY_PACKAGE),
        ]);
        // Charger explicitement l'URL du dashboard plutôt que de compter sur
        // la Start URL configurée DANS Fully : c'est elle qui a cassé en août
        // (yui.home.arpa → 301 https → cert mkcert que la webview du Shield ne
        // connaît pas → page du cache, données mortes). Un intent VIEW épinglé
        // sur Fully est déterministe et se moque du DNS/TLS de la config Fully.
        const url = process.env.DASHBOARD_URL ?? '';
        if (url && ATV_ADB_HOST) {
            try {
                await adbLaunch(url, FULLY_PACKAGE);
            } catch (e) {
                Logger.warn(`launchFully: loadURL via intent: ${e}`);
            }
        }
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
