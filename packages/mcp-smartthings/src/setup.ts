// packages/mcp-smartthings/src/setup.ts
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });
// Lancé via `npm run setup -w packages/mcp-smartthings`, le cwd est le dossier du
// package → dataPath() écrirait sous packages/mcp-smartthings/data/ au lieu de la
// racine (où l'orchestrateur lit). On ancre le data dir sur la racine du repo.
if (!process.env.YUI_DATA_DIR) {
    process.env.YUI_DATA_DIR = resolve(__dirname, '../../../data');
}

import axios from 'axios';
import { SmartThingsAuth, saveSmartThingsCreds } from '@yui/shared';

// Les SmartApps API_ONLY exigent un redirect HTTPS (http://localhost est rejeté
// → 403). Défaut : le domaine de SmartThings lui-même (l'émetteur a déjà le code
// → aucun tiers ; auto-enregistré sur l'app). Après autorisation, l'utilisateur
// copie l'URL de redirection COMPLÈTE depuis la barre d'adresse (avec code+state).
// Ne PAS pointer vers un echo public tiers (httpbin…) : ça ferait transiter le
// code d'autorisation par un tiers.
const REDIRECT_URI =
    process.env.SMARTTHINGS_REDIRECT_URI ||
    'https://api.smartthings.com/installedapp';

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
                'Étapes (voir packages/mcp-smartthings/README.md pour le détail) :\n' +
                "  1. Crée une app OAuth-In via l'API REST (le CLI est buggé) avec\n" +
                `     un redirect HTTPS = ${REDIRECT_URI} et scopes r:devices:* w:devices:* x:devices:*.\n` +
                '  2. Mets dans .env :\n' +
                '     SMARTTHINGS_CLIENT_ID=...\n' +
                '     SMARTTHINGS_CLIENT_SECRET=...\n' +
                '     SMARTTHINGS_REDIRECT_URI=https://httpbin.org/get (optionnel, défaut)\n' +
                '     SMARTTHINGS_DEVICE_ID=... (optionnel — sinon choisi dans la liste affichée)\n' +
                '  3. Relance : npm run setup:smartthings',
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
