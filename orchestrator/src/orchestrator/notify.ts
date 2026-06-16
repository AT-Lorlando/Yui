import { GoogleAuth } from 'google-auth-library';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import Logger from '../logger';
import { dataPath } from '@yui/shared';

const TOKEN_FILE = dataPath('fcm-token.json');
const SERVICE_ACCOUNT_FILE = dataPath('firebase-service-account.json');

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

export async function sendNotification(text: string): Promise<void> {
    Logger.info(`[notify] ${text}`);

    if (!existsSync(SERVICE_ACCOUNT_FILE)) {
        Logger.warn('[notify] No service account file — skipping FCM push');
        return;
    }

    const deviceToken = loadFcmToken();
    if (!deviceToken) {
        Logger.warn('[notify] No FCM device token registered — skipping push');
        return;
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
                        notification: { title: 'Yui', body: text },
                        android: { priority: 'high' },
                    },
                }),
                signal: AbortSignal.timeout(10_000),
            },
        );

        if (!res.ok) {
            const err = await res.text();
            Logger.error(`[notify] FCM error ${res.status}: ${err}`);
        } else {
            Logger.info('[notify] FCM push sent');
        }
    } catch (err: any) {
        Logger.error(`[notify] FCM push failed: ${err.message}`);
    }
}
