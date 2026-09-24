// OAuth du seeder librespot — refait EN NODE.
//
// Pourquoi : depuis 2024, Spotify refuse l'enregistrement Connect (spirc) aux
// tokens des apps tierces ; seul un token obtenu avec le client id de
// librespot passe (`librespot --enable-oauth`). Mais le flux intégré de
// librespot attend la redirection sur SON serveur local 127.0.0.1:5588 —
// impossible depuis un autre appareil — et son parseur d'URL cassait sur les
// paramètres ajoutés par le navigateur (vécu deux fois, 06/09). On fait donc
// le PKCE nous-mêmes avec ce client id : URL à ouvrir n'importe où, URL de
// retour à coller, échange du code ici, refresh token conservé, et librespot
// reçoit un access token frais (`--access-token`) à chaque démarrage.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { dataRoot } from '@yui/shared';
import Logger from './logger';

/** Client id public de librespot (KEYMASTER) — le seul accepté par spirc. */
export const LIBRESPOT_CLIENT_ID = '65b708073fc0480ea92a077233ca87bd';
export const REDIRECT_URI = 'http://127.0.0.1:5588/login';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTH_URL = 'https://accounts.spotify.com/authorize';
/** Scopes que librespot demande lui-même (identiques à son --enable-oauth). */
export const SEEDER_SCOPES = [
    'app-remote-control',
    'playlist-modify',
    'playlist-modify-private',
    'playlist-modify-public',
    'playlist-read',
    'playlist-read-collaborative',
    'playlist-read-private',
    'streaming',
    'ugc-image-upload',
    'user-follow-modify',
    'user-follow-read',
    'user-library-modify',
    'user-library-read',
    'user-modify',
    'user-modify-playback-state',
    'user-modify-private',
    'user-personalized',
    'user-read-birthdate',
    'user-read-currently-playing',
    'user-read-email',
    'user-read-play-history',
    'user-read-playback-position',
    'user-read-playback-state',
    'user-read-private',
    'user-read-recently-played',
    'user-top-read',
];

export interface SeederToken {
    refresh_token: string;
    access_token: string;
    /** Epoch ms. */
    expires_at: number;
}

export function seederTokenFile(): string {
    return (
        process.env.LIBRESPOT_TOKEN_FILE ??
        path.join(dataRoot(), 'shared', 'librespot', 'seeder-token.json')
    );
}

const b64url = (buf: Buffer): string =>
    buf
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

/** PKCE : verifier aléatoire + challenge S256. Pur, testé. */
export function pkcePair(verifier?: string): {
    verifier: string;
    challenge: string;
} {
    const v = verifier ?? b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(v).digest());
    return { verifier: v, challenge };
}

/** URL d'autorisation à ouvrir (n'importe quel appareil). Pur, testé. */
export function buildAuthUrl(challenge: string, state: string): string {
    const u = new URL(AUTH_URL);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', LIBRESPOT_CLIENT_ID);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('redirect_uri', REDIRECT_URI);
    u.searchParams.set('scope', SEEDER_SCOPES.join(' '));
    return u.toString();
}

/** `code` depuis un code brut ou l'URL de retour collée. Pur, testé. */
export function codeFromInput(raw: string): string {
    const s = raw.trim();
    try {
        const u = new URL(s);
        return u.searchParams.get('code') ?? s;
    } catch {
        return s;
    }
}

async function postToken(params: Record<string, string>): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
}> {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: LIBRESPOT_CLIENT_ID,
            ...params,
        }).toString(),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Spotify token endpoint ${res.status}: ${body}`);
    }
    return (await res.json()) as any;
}

export async function exchangeCode(
    code: string,
    verifier: string,
): Promise<SeederToken> {
    const t = await postToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
    });
    if (!t.refresh_token)
        throw new Error('pas de refresh_token dans la réponse');
    return {
        refresh_token: t.refresh_token,
        access_token: t.access_token,
        expires_at: Date.now() + t.expires_in * 1000,
    };
}

export function loadSeederToken(file = seederTokenFile()): SeederToken | null {
    try {
        if (!fs.existsSync(file)) return null;
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return raw?.refresh_token ? (raw as SeederToken) : null;
    } catch {
        return null;
    }
}

export function saveSeederToken(
    t: SeederToken,
    file = seederTokenFile(),
): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(t, null, 2), { mode: 0o600 });
}

export function hasSeederToken(): boolean {
    return loadSeederToken() !== null;
}

/** Marge avant expiration sous laquelle on rafraîchit. Pur, testé. */
export function needsRefresh(t: SeederToken, now = Date.now()): boolean {
    return t.expires_at - now < 5 * 60_000;
}

/**
 * Access token frais pour librespot (`--access-token`). Rafraîchit et
 * persiste si besoin (Spotify fait tourner le refresh token : on garde le
 * nouveau quand il en renvoie un).
 */
export async function getSeederAccessToken(): Promise<string | null> {
    const t = loadSeederToken();
    if (!t) return null;
    if (!needsRefresh(t)) return t.access_token;
    const r = await postToken({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
    });
    const next: SeederToken = {
        refresh_token: r.refresh_token ?? t.refresh_token,
        access_token: r.access_token,
        expires_at: Date.now() + r.expires_in * 1000,
    };
    saveSeederToken(next);
    Logger.info('Seeder : token librespot rafraîchi');
    return next.access_token;
}
