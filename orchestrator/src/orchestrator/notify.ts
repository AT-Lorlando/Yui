import { GoogleAuth } from 'google-auth-library';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import http from 'http';
import Logger from '../logger';
import { dataPath } from '@yui/shared';

const TOKEN_FILE = dataPath('fcm-token.json');
const SERVICE_ACCOUNT_FILE = dataPath('firebase-service-account.json');

// voice/tts.py exposes a /speak endpoint on this port
const SPEAK_PIPELINE_URL =
    process.env.SPEAK_PIPELINE_URL ?? 'http://localhost:3001/speak';

export function saveFcmToken(token: string): void {
    writeFileSync(TOKEN_FILE, JSON.stringify({ token }));
    Logger.info('[notify] FCM token saved');
}

function loadFcmToken(): string | null {
    if (!existsSync(TOKEN_FILE)) return null;
    try {
        return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')).token;
    } catch {
        return null;
    }
}

async function getAccessToken(): Promise<string> {
    const credentials = JSON.parse(readFileSync(SERVICE_ACCOUNT_FILE, 'utf-8'));
    const auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to obtain FCM access token');
    return token;
}

/**
 * Push FCM sur le téléphone. Retourne `true` si le push est parti ; `false`
 * (sans lever) s'il manque le compte de service ou le token appareil, ou si
 * FCM refuse — l'appelant a déjà journalisé, la notification ne doit jamais
 * casser l'action qui l'émet.
 */
export async function pushNotification(
    text: string,
    opts: { title?: string } = {},
): Promise<boolean> {
    Logger.info(`[notify] ${text}`);

    if (!existsSync(SERVICE_ACCOUNT_FILE)) {
        Logger.warn('[notify] No service account file — skipping FCM push');
        return false;
    }

    const deviceToken = loadFcmToken();
    if (!deviceToken) {
        Logger.warn('[notify] No FCM device token registered — skipping push');
        return false;
    }

    try {
        const credentials = JSON.parse(
            readFileSync(SERVICE_ACCOUNT_FILE, 'utf-8'),
        );
        const projectId: string = credentials.project_id;
        const accessToken = await getAccessToken();

        const res = await fetch(
            `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: {
                        token: deviceToken,
                        notification: {
                            title: opts.title ?? 'Yui',
                            body: text,
                        },
                        android: { priority: 'high' },
                    },
                }),
                signal: AbortSignal.timeout(10_000),
            },
        );

        if (!res.ok) {
            const err = await res.text();
            Logger.error(`[notify] FCM error ${res.status}: ${err}`);
            return false;
        }
        Logger.info('[notify] FCM push sent');
        return true;
    } catch (err: any) {
        Logger.error(`[notify] FCM push failed: ${err.message}`);
        return false;
    }
}

/** Forme historique (automations, proactivité, notify_user) : ne renvoie rien. */
export async function sendNotification(text: string): Promise<void> {
    await pushNotification(text);
}

/**
 * Lit un texte à voix haute via le pipeline voix (`POST /speak`). Retourne
 * `false` sans lever si le pipeline ne tourne pas — automations, proactivité
 * et `/notify` ne doivent jamais échouer parce que la voix est down.
 */
export async function speakText(text: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const body = JSON.stringify({ text });
            const url = new URL(SPEAK_PIPELINE_URL);
            const req = http.request(
                {
                    hostname: url.hostname,
                    port: url.port || 80,
                    path: url.pathname,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                },
                (res) => {
                    res.resume(); // drain response
                    resolve((res.statusCode ?? 500) < 400);
                },
            );
            req.on('error', () => resolve(false)); // pipeline not running — ignore
            req.write(body);
            req.end();
        } catch {
            resolve(false);
        }
    });
}
