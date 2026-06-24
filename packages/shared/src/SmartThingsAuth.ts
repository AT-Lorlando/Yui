// packages/shared/src/SmartThingsAuth.ts
import axios from 'axios';
import http from 'http';
import { URL } from 'url';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from './dataPaths';
import {
    loadSmartThingsCreds,
    saveSmartThingsCreds,
    SmartThingsCreds,
} from './smartThingsConfig';

const TOKEN_URL = 'https://api.smartthings.com/oauth/token';
const AUTHORIZE_URL = 'https://api.smartthings.com/oauth/authorize';
const SCOPES = 'r:devices:* x:devices:*';

export interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
}
export interface TokenCache {
    accessToken: string;
    expiresAt: number;
}

function cacheFile(): string {
    return dataPath('smartthings-token.json');
}

/** Pure : creds à persister (rotation) + cache access-token à écrire. */
export function applyTokenResponse(
    creds: SmartThingsCreds,
    res: TokenResponse,
    nowMs: number,
): { creds: SmartThingsCreds; cache: TokenCache } {
    const refreshToken = res.refresh_token ?? creds.refreshToken;
    const expiresAt = nowMs + (res.expires_in ?? 86400) * 1000;
    return {
        creds: { ...creds, refreshToken },
        cache: { accessToken: res.access_token, expiresAt },
    };
}

function basicHeader(clientId: string, clientSecret: string): string {
    return (
        'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    );
}

export class SmartThingsAuth {
    private static readCache(): TokenCache | null {
        try {
            const f = cacheFile();
            if (fs.existsSync(f))
                return JSON.parse(fs.readFileSync(f, 'utf-8')) as TokenCache;
        } catch {
            /* ignore */
        }
        return null;
    }

    private static writeCache(c: TokenCache): void {
        const f = cacheFile();
        fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
        fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
    }

    /** Access token valide depuis le cache, sinon refresh. */
    static async getAccessToken(): Promise<string> {
        const cache = SmartThingsAuth.readCache();
        if (cache && cache.expiresAt > Date.now() + 60_000)
            return cache.accessToken;
        return SmartThingsAuth.refresh();
    }

    /** Rafraîchit l'access token, persiste le refresh token rotaté. */
    static async refresh(): Promise<string> {
        const creds = loadSmartThingsCreds();
        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: creds.refreshToken,
        });
        const res = await axios.post(TOKEN_URL, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: basicHeader(creds.clientId, creds.clientSecret),
            },
        });
        const out = applyTokenResponse(creds, res.data, Date.now());
        saveSmartThingsCreds(out.creds);
        SmartThingsAuth.writeCache(out.cache);
        return out.cache.accessToken;
    }

    /** Flow Authorization Code (setup). Renvoie access + refresh tokens. */
    static async startAuthFlow(
        clientId: string,
        clientSecret: string,
        redirectUri: string,
    ): Promise<{ accessToken: string; refreshToken: string }> {
        const state = randomBytes(32).toString('base64url');
        const authorizeUrl =
            `${AUTHORIZE_URL}?` +
            new URLSearchParams({
                client_id: clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                scope: SCOPES,
                state,
            }).toString();
        console.log('\nOuvre cette URL pour autoriser Yui (SmartThings):\n');
        console.log(`  ${authorizeUrl}\n`);

        const code = await SmartThingsAuth.waitForCallback(redirectUri, state);
        const params = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
        });
        const res = await axios.post(TOKEN_URL, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: basicHeader(clientId, clientSecret),
            },
        });
        return {
            accessToken: res.data.access_token,
            refreshToken: res.data.refresh_token,
        };
    }

    private static waitForCallback(
        redirectUri: string,
        expectedState: string,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(redirectUri);
            const port = Number(parsed.port) || 6147;
            const callbackPath = parsed.pathname || '/callback';
            const host =
                parsed.hostname === 'localhost' ||
                parsed.hostname === '127.0.0.1'
                    ? '127.0.0.1'
                    : '0.0.0.0';
            const server = http.createServer((req, res) => {
                const u = new URL(req.url ?? '', `http://localhost:${port}`);
                if (u.pathname !== callbackPath) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }
                const code = u.searchParams.get('code');
                const error = u.searchParams.get('error');
                if (error) {
                    res.writeHead(400);
                    res.end('<h1>Autorisation refusée</h1>');
                    server.close();
                    reject(new Error(`Authorization denied: ${error}`));
                    return;
                }
                if (code) {
                    const returnedState = u.searchParams.get('state');
                    if (returnedState !== expectedState) {
                        res.writeHead(400);
                        res.end('<h1>State invalide (CSRF)</h1>');
                        server.close();
                        reject(new Error('OAuth state mismatch (CSRF)'));
                        return;
                    }
                    res.writeHead(200);
                    res.end('<h1>Autorisé ! Tu peux fermer cet onglet.</h1>');
                    server.close();
                    resolve(code);
                    return;
                }
                res.writeHead(400);
                res.end('<h1>Code manquant</h1>');
            });
            server.listen(port, host, () => {
                console.log(
                    `En attente du callback sur ${host}:${port}${callbackPath}`,
                );
            });
            setTimeout(() => {
                server.close();
                reject(new Error('Authorization timed out after 2 minutes'));
            }, 120_000);
        });
    }
}
