// packages/shared/src/SmartThingsAuth.test.ts
import assert from 'assert';
import { applyTokenResponse, SmartThingsAuth } from './SmartThingsAuth';

async function run() {
    const base = {
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'OLD',
        deviceId: 'd',
    };
    // rotation : un nouveau refresh_token remplace l'ancien
    {
        const { creds, cache } = applyTokenResponse(
            base,
            { access_token: 'AT', refresh_token: 'NEW', expires_in: 86400 },
            1_000_000,
        );
        assert.strictEqual(creds.refreshToken, 'NEW');
        assert.strictEqual(cache.accessToken, 'AT');
        assert.strictEqual(cache.expiresAt, 1_000_000 + 86400 * 1000);
        // les autres champs sont préservés
        assert.strictEqual(creds.deviceId, 'd');
    }
    // pas de refresh_token dans la réponse → on garde l'ancien
    {
        const { creds } = applyTokenResponse(base, { access_token: 'AT2' }, 0);
        assert.strictEqual(creds.refreshToken, 'OLD');
    }
    // parseCode : URL de redirection collée → extrait code + state
    {
        const r = SmartThingsAuth.parseCode(
            'https://httpbin.org/get?code=ABC123&state=xyz',
        );
        assert.strictEqual(r.code, 'ABC123');
        assert.strictEqual(r.returnedState, 'xyz');
    }
    // parseCode : code brut collé (pas une URL) → code, state null
    {
        const r = SmartThingsAuth.parseCode('  RAWCODE  ');
        assert.strictEqual(r.code, 'RAWCODE');
        assert.strictEqual(r.returnedState, null);
    }
    // parseCode : entrée vide → code null
    {
        assert.strictEqual(SmartThingsAuth.parseCode('   ').code, null);
    }
    console.log('All SmartThingsAuth tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
