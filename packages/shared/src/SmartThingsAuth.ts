// packages/shared/src/SmartThingsAuth.ts
import axios from 'axios';
import { URL } from 'url';
import * as readline from 'readline';
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

    /**
     * Flow Authorization Code en mode "coller le code" (headless-friendly).
     * Les SmartApps API_ONLY rejettent les redirects non-HTTPS (donc pas de
     * `http://localhost` ni de serveur de callback local) : l'utilisateur
     * autorise dans un navigateur via un redirect HTTPS, puis colle l'URL de
     * redirection (ou juste le code) dans le terminal. Renvoie access + refresh.
     */
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
        console.log(
            '\n1. Ouvre cette URL dans un navigateur et autorise Yui ' +
                '(sélectionne la Location qui contient la TV) :\n',
        );
        console.log(`  ${authorizeUrl}\n`);
        console.log(
            `2. Tu seras redirigé vers ${redirectUri} avec ?code=...&state=...\n`,
        );

        const pasted = await SmartThingsAuth.prompt(
            "3. Colle l'URL de redirection COMPLÈTE depuis la barre d'adresse " +
                '(elle contient code + state) : ',
        );
        const { code, returnedState } = SmartThingsAuth.parseCode(pasted);
        if (!code)
            throw new Error('Aucun code trouvé dans ce que tu as collé.');
        // Vérif CSRF fail-closed : le state DOIT être présent et correspondre.
        // Coller juste le code (sans state) est refusé — colle l'URL complète.
        if (returnedState !== state)
            throw new Error(
                'State OAuth absent ou invalide (CSRF). Colle bien l’URL de ' +
                    'redirection COMPLÈTE (avec ?code=…&state=…), puis relance.',
            );

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

    /**
     * Extrait `code` (+ `state`) d'une URL de redirection collée. Si l'entrée
     * n'est pas une URL, elle est traitée comme le code brut. Pure (testable).
     */
    static parseCode(input: string): {
        code: string | null;
        returnedState: string | null;
    } {
        const trimmed = input.trim();
        try {
            const u = new URL(trimmed);
            return {
                code: u.searchParams.get('code'),
                returnedState: u.searchParams.get('state'),
            };
        } catch {
            return { code: trimmed || null, returnedState: null };
        }
    }

    private static prompt(question: string): Promise<string> {
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    }
}
