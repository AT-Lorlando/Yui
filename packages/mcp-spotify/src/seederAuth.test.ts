import assert from 'assert';
import {
    buildAuthUrl,
    codeFromInput,
    needsRefresh,
    pkcePair,
    LIBRESPOT_CLIENT_ID,
    REDIRECT_URI,
} from './seederAuth';

// PKCE : challenge S256 base64url déterministe pour un verifier donné.
const p = pkcePair('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
assert.strictEqual(p.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
assert.ok(pkcePair().verifier.length >= 43, 'verifier assez long');
assert.notStrictEqual(pkcePair().verifier, pkcePair().verifier);

// URL d'autorisation : client id librespot, PKCE, redirect 127.0.0.1:5588.
const url = new URL(buildAuthUrl('CHAL', 'STATE1'));
assert.strictEqual(url.searchParams.get('client_id'), LIBRESPOT_CLIENT_ID);
assert.strictEqual(url.searchParams.get('code_challenge'), 'CHAL');
assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
assert.strictEqual(url.searchParams.get('redirect_uri'), REDIRECT_URI);
assert.ok(url.searchParams.get('scope')!.includes('streaming'));

// Code : brut, ou extrait de l'URL de retour collée (avec les paramètres
// parasites du navigateur qui faisaient planter le parseur de librespot).
assert.strictEqual(codeFromInput('AQabc'), 'AQabc');
assert.strictEqual(
    codeFromInput('http://127.0.0.1:5588/login?code=AQxyz&state=S&ubi=1'),
    'AQxyz',
);

// Rafraîchir sous 5 min d'expiration.
const now = 1_000_000;
assert.strictEqual(
    needsRefresh(
        {
            refresh_token: 'r',
            access_token: 'a',
            expires_at: now + 10 * 60_000,
        },
        now,
    ),
    false,
);
assert.strictEqual(
    needsRefresh(
        { refresh_token: 'r', access_token: 'a', expires_at: now + 2 * 60_000 },
        now,
    ),
    true,
);

console.log('All seederAuth tests passed');
