// packages/mcp-smartthings/src/setup.ts
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import axios from 'axios';
import { SmartThingsAuth, saveSmartThingsCreds } from '@yui/shared';

const REDIRECT_URI =
    process.env.SMARTTHINGS_REDIRECT_URI || 'http://localhost:6147/callback';

async function listDevices(accessToken: string) {
    const res = await axios.get('https://api.smartthings.com/v1/devices', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    return (res.data.items ?? []) as Array<{
        deviceId: string;
        label?: string;
        name?: string;
        deviceTypeName?: string;
    }>;
}

async function main() {
    console.log('=== Yui — SmartThings Auth Setup ===\n');
    const clientId = process.env.SMARTTHINGS_CLIENT_ID;
    const clientSecret = process.env.SMARTTHINGS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        console.error(
            'SMARTTHINGS_CLIENT_ID et SMARTTHINGS_CLIENT_SECRET doivent être dans .env.\n\n' +
                'Étapes :\n' +
                '  1. Installe le CLI SmartThings (npm i -g @smartthings/cli) ou va sur le developer workspace.\n' +
                `  2. Crée un client OAuth (redirect URI = ${REDIRECT_URI}, scopes r:devices:* x:devices:*).\n` +
                '  3. Mets dans .env :\n' +
                '     SMARTTHINGS_CLIENT_ID=...\n' +
                '     SMARTTHINGS_CLIENT_SECRET=...\n' +
                '     SMARTTHINGS_REDIRECT_URI=http://<host>:6147/callback (optionnel)\n' +
                '     SMARTTHINGS_DEVICE_ID=... (optionnel — sinon choisi dans la liste affichée)\n' +
                '  4. Relance : npm run setup:smartthings',
        );
        process.exit(1);
    }

    console.log("Lancement du flow d'autorisation OAuth...");
    const tokens = await SmartThingsAuth.startAuthFlow(
        clientId,
        clientSecret,
        REDIRECT_URI,
    );

    console.log('\nDevices SmartThings de ton compte :');
    const devices = await listDevices(tokens.accessToken);
    for (const d of devices) {
        console.log(
            `  - ${d.label || d.name} (${d.deviceTypeName ?? ''}) → ${
                d.deviceId
            }`,
        );
    }

    const deviceId =
        process.env.SMARTTHINGS_DEVICE_ID ||
        devices.find((d) => (d.deviceTypeName ?? '').includes('TV'))
            ?.deviceId ||
        '';

    if (!deviceId) {
        console.error(
            '\nAucun deviceId résolu. Repère ta TV ci-dessus et relance avec ' +
                'SMARTTHINGS_DEVICE_ID=<id> dans .env.',
        );
        process.exit(1);
    }

    saveSmartThingsCreds({
        clientId,
        clientSecret,
        refreshToken: tokens.refreshToken,
        deviceId,
    });
    console.log(`\n=== Setup terminé ===`);
    console.log(`TV deviceId : ${deviceId}`);
    console.log('Credentials écrits dans data/shared/smartthings.json');
    console.log('\nTu peux maintenant lancer : npm run dev:smartthings');
}

main().catch((err) => {
    console.error('\nSetup failed:', err.message);
    process.exit(1);
});
