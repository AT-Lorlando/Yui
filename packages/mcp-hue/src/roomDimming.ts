import https from 'https';
import Logger from './logger';

// Luminosité de pièce SANS toucher aux couleurs (25/11/2026).
//
// Vécu : après une scène colorée, régler la luminosité de la pièce (curseur
// de l'app) faisait revenir les couleurs d'avant la scène. Le chemin v1
// (`PUT /groups/<id>/action {on: true, bri}`) en était la cause probable ; la
// molette des télécommandes, qui passe par le `grouped_light` v2
// (`dimming_delta`), n'a jamais eu le problème. Une écriture de luminosité
// SEULE sur une pièce entièrement allumée passe donc désormais par un
// `PUT grouped_light {dimming}` v2 : pas d'`on`, pas de couleur.

export interface RoomWrite {
    on?: boolean;
    brightness?: number;
    brightnessDelta?: number;
    color?: string;
    colorTempK?: number;
}

/**
 * Pur : l'écriture peut-elle passer par le gradateur v2 ? Seulement une
 * luminosité absolue, sans couleur ni alimentation explicite à éteindre, sur
 * une pièce dont TOUTES les lampes sont allumées (sinon il faut aussi les
 * allumer : le chemin v1 le fait).
 */
export function isPureDimming(w: RoomWrite, lightsOn: boolean[]): boolean {
    return (
        w.brightness !== undefined &&
        Number.isFinite(w.brightness) &&
        w.brightnessDelta === undefined &&
        w.color === undefined &&
        w.colorTempK === undefined &&
        w.on !== false &&
        lightsOn.length > 0 &&
        lightsOn.every(Boolean)
    );
}

/** Pur : corps du PUT grouped_light (luminosité bornée 1–100). */
export function dimmingBody(
    brightness: number,
    transitionMs?: number,
): Record<string, unknown> {
    return {
        dimming: { brightness: Math.max(1, Math.min(100, brightness)) },
        ...(transitionMs !== undefined && Number.isFinite(transitionMs)
            ? { dynamics: { duration: Math.max(0, Math.round(transitionMs)) } }
            : {}),
    };
}

/** Client v2 minimal : groupe v1 → grouped_light v2, puis PUT dimming. */
export class RoomDimmer {
    private byV1 = new Map<number, string>();
    private loaded: Promise<void> | null = null;

    constructor(private readonly host: string, private readonly key: string) {}

    private request(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const payload =
                body === undefined ? undefined : JSON.stringify(body);
            const req = https.request(
                {
                    host: this.host,
                    path,
                    method,
                    rejectUnauthorized: false,
                    timeout: 4000,
                    headers: {
                        'hue-application-key': this.key,
                        Accept: 'application/json',
                        ...(payload
                            ? {
                                  'Content-Type': 'application/json',
                                  'Content-Length': Buffer.byteLength(payload),
                              }
                            : {}),
                    },
                },
                (res) => {
                    let buf = '';
                    res.on('data', (c) => (buf += c));
                    res.on('end', () => {
                        let json: any = {};
                        try {
                            json = buf ? JSON.parse(buf) : {};
                        } catch {
                            /* corps non JSON */
                        }
                        if ((res.statusCode ?? 500) >= 300) {
                            reject(
                                new Error(
                                    `hue v2 ${method} ${path} → ${
                                        res.statusCode
                                    } ${
                                        json?.errors?.[0]?.description ?? ''
                                    }`.trim(),
                                ),
                            );
                        } else resolve(json);
                    });
                },
            );
            req.on('timeout', () => req.destroy(new Error('hue v2 timeout')));
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    private async load(): Promise<void> {
        const out = new Map<number, string>();
        for (const kind of ['room', 'zone']) {
            const resp = await this.request('GET', `/clip/v2/resource/${kind}`);
            for (const r of resp.data ?? []) {
                const v1 = Number(
                    String(r.id_v1 ?? '')
                        .split('/')
                        .pop(),
                );
                const grouped = (r.services ?? []).find(
                    (s: any) => s.rtype === 'grouped_light',
                );
                if (Number.isFinite(v1) && grouped) out.set(v1, grouped.rid);
            }
        }
        this.byV1 = out;
    }

    /**
     * Règle la luminosité du groupe v1 `groupId`. Lève si le groupe est
     * inconnu du v2 ou si le bridge refuse : l'appelant retombe sur le v1.
     */
    async dim(
        groupId: number,
        brightness: number,
        transitionMs?: number,
    ): Promise<void> {
        if (!this.byV1.has(groupId)) {
            // Relecture une fois (pièce créée depuis le démarrage, 1er appel).
            this.loaded = null;
        }
        if (!this.loaded) {
            this.loaded = this.load().catch((e) => {
                this.loaded = null;
                throw e;
            });
        }
        await this.loaded;
        const rid = this.byV1.get(groupId);
        if (!rid) throw new Error(`groupe ${groupId} sans grouped_light v2`);
        await this.request(
            'PUT',
            `/clip/v2/resource/grouped_light/${rid}`,
            dimmingBody(brightness, transitionMs),
        );
        Logger.debug(`[hue] pièce ${groupId} → ${brightness}% (v2 dimming)`);
    }
}
