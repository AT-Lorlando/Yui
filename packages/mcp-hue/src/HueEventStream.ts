import https from 'https';
import Logger from './logger';
import {
    parseSseChunk,
    eventsToPatches,
    buildLightIdMap,
    type LightStatePatch,
    type HueV2LightResource,
} from './stateEvents';

/**
 * Abonnement au flux SSE du bridge Hue v2 — l'état des lampes est poussé par
 * le bridge, quelle que soit l'origine du changement (app Hue, interrupteur,
 * télécommande, nous). C'est ce qui remplace la relecture périodique.
 *
 * Un second abonnement coexiste côté orchestrateur pour les télécommandes : le
 * bridge accepte plusieurs connexions, et chaque processus reste maître de ce
 * qu'il en fait. mcp-hue possède l'état des lampes, donc il possède sa
 * fraîcheur.
 */
export interface HueEventStreamOptions {
    host: string;
    key: string;
    onPatches: (patches: LightStatePatch[]) => void;
    /** Rappelé après (re)connexion — le temps d'une reprise, on a pu rater des events. */
    onReconnect?: () => void;
}

const RETRY_MS = 5_000;
const HTTP_RETRY_MS = 10_000;

export class HueEventStream {
    private idMap = new Map<string, number>();
    private req: ReturnType<typeof https.request> | null = null;
    private stopped = false;
    private connected = false;
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly opts: HueEventStreamOptions) {}

    /** Le flux est-il actuellement établi ? */
    isLive(): boolean {
        return this.connected;
    }

    /** Charge la correspondance UUID v2 → id v1. À rejouer si des lampes changent. */
    async loadIdMap(): Promise<number> {
        const res = await this.get('/clip/v2/resource/light');
        this.idMap = buildLightIdMap((res?.data ?? []) as HueV2LightResource[]);
        return this.idMap.size;
    }

    start(): void {
        this.stopped = false;
        this.open();
    }

    stop(): void {
        this.stopped = true;
        this.connected = false;
        if (this.timer) clearTimeout(this.timer);
        this.req?.destroy();
        this.req = null;
    }

    private retry(ms: number): void {
        if (this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.open(), ms);
    }

    private open(): void {
        if (this.stopped) return;
        const req = https.request(
            {
                host: this.opts.host,
                path: '/eventstream/clip/v2',
                method: 'GET',
                rejectUnauthorized: false,
                headers: {
                    'hue-application-key': this.opts.key,
                    Accept: 'text/event-stream',
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    Logger.warn(
                        `[hue-events] HTTP ${
                            res.statusCode
                        } — nouvelle tentative dans ${HTTP_RETRY_MS / 1000}s`,
                    );
                    res.resume();
                    this.connected = false;
                    this.retry(HTTP_RETRY_MS);
                    return;
                }
                this.connected = true;
                Logger.info('[hue-events] flux connecté');
                this.opts.onReconnect?.();

                let buffer = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    const { events, remainder } = parseSseChunk(buffer);
                    buffer = remainder;
                    if (!events.length) return;
                    const patches = eventsToPatches(events, this.idMap);
                    if (patches.length) this.opts.onPatches(patches);
                });
                res.on('end', () => {
                    this.connected = false;
                    Logger.warn('[hue-events] flux terminé, reconnexion');
                    this.retry(RETRY_MS);
                });
            },
        );
        req.on('error', (err) => {
            this.connected = false;
            Logger.warn(`[hue-events] erreur: ${err.message}`);
            this.retry(HTTP_RETRY_MS);
        });
        req.end();
        this.req = req;
    }

    private get(path: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    host: this.opts.host,
                    path,
                    method: 'GET',
                    rejectUnauthorized: false,
                    headers: {
                        'hue-application-key': this.opts.key,
                        Accept: 'application/json',
                    },
                },
                (res) => {
                    let buf = '';
                    res.on('data', (c) => (buf += c));
                    res.on('end', () => {
                        try {
                            resolve(buf ? JSON.parse(buf) : {});
                        } catch (e) {
                            reject(e);
                        }
                    });
                },
            );
            req.on('error', reject);
            req.end();
        });
    }
}
