import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import path from 'path';
import fs from 'fs';
import SpotifyWebApi from 'spotify-web-api-node';
import { SpotifyAuth } from './SpotifyAuth';
import { SpotifyController } from './SpotifyController';
import { EntityStore } from '@yui/shared';
import type { SpeakerEntity } from '@yui/shared';
import { discoverSpeakers } from './discovery';

const ROOT_ENV_PATH = path.resolve(__dirname, '../../../.env');
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:6145/callback';

function updateEnvFile(key: string, value: string): void {
    let content = '';
    if (fs.existsSync(ROOT_ENV_PATH)) {
        content = fs.readFileSync(ROOT_ENV_PATH, 'utf-8');
    }

    const regex = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;

    if (regex.test(content)) {
        content = content.replace(regex, line);
    } else {
        content = content.trimEnd() + '\n' + line + '\n';
    }

    fs.writeFileSync(ROOT_ENV_PATH, content, 'utf-8');
}

async function setupAuth() {
    console.log('=== Yui — Spotify Auth Setup ===\n');

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error(
            'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env before running setup.\n\n' +
                'Steps:\n' +
                '  1. Go to https://developer.spotify.com/dashboard\n' +
                '  2. Create an app (set redirect URI matching SPOTIFY_REDIRECT_URI in .env)\n' +
                '  3. Copy Client ID and Client Secret\n' +
                '  4. Add to .env:\n' +
                '     SPOTIFY_CLIENT_ID=your_client_id\n' +
                '     SPOTIFY_CLIENT_SECRET=your_client_secret\n' +
                '     SPOTIFY_REDIRECT_URI=http://your-host:6145/callback\n' +
                '  5. Run this setup again: npm run setup:spotify',
        );
        process.exit(1);
    }

    console.log('Starting OAuth authorization flow...');
    const tokens = await SpotifyAuth.startAuthFlow(
        clientId,
        clientSecret,
        REDIRECT_URI,
    );

    updateEnvFile('SPOTIFY_CLIENT_ID', clientId);
    updateEnvFile('SPOTIFY_CLIENT_SECRET', clientSecret);
    updateEnvFile('SPOTIFY_REFRESH_TOKEN', tokens.refreshToken);
    console.log(`\nCredentials written to ${ROOT_ENV_PATH}`);

    const api = new SpotifyWebApi({ clientId, clientSecret });
    api.setAccessToken(tokens.accessToken);
    api.setRefreshToken(tokens.refreshToken);

    const me = await api.getMe();
    console.log(`\n=== Auth complete ===`);
    console.log(`Account: ${me.body.display_name} (${me.body.email})`);
    console.log('\nRun "npm run setup:spotify:speakers" to discover and link speakers.');
}

async function setupSpeakers() {
    console.log('=== Yui — Spotify Speaker Setup ===\n');
    console.log(
        'Make sure all speakers are powered on and have been used with\n' +
            'Spotify recently (open Spotify app → Devices → select each speaker once).\n',
    );

    const api = await SpotifyAuth.connect();
    const spotify = new SpotifyController(api);

    const devices = await spotify.getDevices();
    console.log(`Spotify Connect devices: ${devices.length}`);
    for (const d of devices) {
        console.log(`  - ${d.name} (${d.type}, id: ${d.id})`);
    }

    console.log('\nDiscovering speakers on local network...');
    const projectRoot = resolve(__dirname, '../../..');
    const store = new EntityStore<SpeakerEntity>('mcp-spotify', projectRoot);
    store.loadSnapshot();
    await discoverSpeakers(spotify, store);
    const speakers = store.getAll();

    console.log('\n=== Speaker setup complete ===');
    console.log(`Speakers: ${speakers.length}`);
    for (const s of speakers) {
        const linked = s.spotifyDeviceId ? ' (Spotify linked)' : '';
        console.log(`  - ${s.name}${s.deviceModel ? ` (${s.deviceModel})` : ''}${linked}`);
    }

    const unlinked = speakers.filter((s) => !s.spotifyDeviceId);
    if (unlinked.length > 0) {
        console.log(
            `\n${unlinked.length} speaker(s) not linked to Spotify.` +
                '\nPlay something on them via the Spotify app, then run this command again.',
        );
    }

    console.log('\nYou can now run: npm run dev:spotify');
}

const command = process.argv[2];

if (command === 'speakers') {
    setupSpeakers().catch((err) => {
        console.error('\nSetup failed:', err.message);
        process.exit(1);
    });
} else {
    setupAuth().catch((err) => {
        console.error('\nSetup failed:', err.message);
        process.exit(1);
    });
}
