import { resolve } from 'path';
import * as readline from 'readline';
import dotenv from 'dotenv';
import { GoogleAuth } from './GoogleAuth';

dotenv.config({ path: resolve(__dirname, '../../../.env') });

function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => {
        rl.question(question, (answer) => {
            rl.close();
            res(answer.trim());
        });
    });
}

async function main() {
    console.log('\n=== Google Services Setup (Calendar + Gmail) ===\n');
    console.log('This creates ONE token that covers both Google Calendar and Gmail.');
    console.log('You only need to run this once.\n');
    console.log('Prerequisites:');
    console.log('  1. Go to https://console.cloud.google.com/');
    console.log('  2. Create/open a project');
    console.log('  3. Enable both APIs:');
    console.log('     - Google Calendar API');
    console.log('     - Gmail API');
    console.log('  4. Create OAuth 2.0 credentials (Desktop app)');
    console.log('     APIs & Services → Credentials → Create → OAuth client ID → Desktop app');
    console.log('  5. Add your Google account to OAuth test users if app is in test mode\n');

    let clientId     = process.env.GOOGLE_CLIENT_ID;
    let clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (clientId) {
        console.log('✓ Using existing GOOGLE_CLIENT_ID from .env');
    } else {
        clientId = await prompt('Client ID: ');
        GoogleAuth.updateEnvFile('GOOGLE_CLIENT_ID', clientId);
    }

    if (clientSecret) {
        console.log('✓ Using existing GOOGLE_CLIENT_SECRET from .env');
    } else {
        clientSecret = await prompt('Client Secret: ');
        GoogleAuth.updateEnvFile('GOOGLE_CLIENT_SECRET', clientSecret);
    }

    console.log('\nStarting OAuth2 authorization flow…');
    console.log('A URL will appear below — open it in your browser.\n');

    try {
        const { refreshToken } = await GoogleAuth.startAuthFlow(clientId, clientSecret);
        GoogleAuth.updateEnvFile('GOOGLE_REFRESH_TOKEN', refreshToken);

        console.log('\n✅ Setup complete! GOOGLE_REFRESH_TOKEN saved to .env');
        console.log('   Both Google Calendar and Gmail are now authorized.\n');
        console.log('Test:');
        console.log('  npm run dev:calendar');
        console.log('  npm run dev:gmail');
    } catch (error) {
        console.error('\n❌ Setup failed:', error);
        process.exit(1);
    }
}

main();
