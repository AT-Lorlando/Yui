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
    console.log('\n=== Google Calendar Setup ===\n');
    console.log('Prerequisites:');
    console.log('  1. Go to https://console.cloud.google.com/');
    console.log('  2. Create a project (or use an existing one)');
    console.log('  3. Enable the "Google Calendar API"');
    console.log('     APIs & Services → Enable APIs → search "Google Calendar API"');
    console.log('  4. Create OAuth 2.0 credentials');
    console.log('     APIs & Services → Credentials → Create → OAuth client ID → Desktop app');
    console.log('  5. Add your Google account to the OAuth test users if the app is in test mode');
    console.log('     OAuth consent screen → Test users → Add users\n');

    let clientId = process.env.GOOGLE_CLIENT_ID;
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

    console.log('\nStarting OAuth2 authorization flow...');
    console.log('A URL will appear below — open it in your browser.\n');

    try {
        const { refreshToken } = await GoogleAuth.startAuthFlow(clientId, clientSecret);
        GoogleAuth.updateEnvFile('GOOGLE_CALENDAR_REFRESH_TOKEN', refreshToken);

        console.log('\n✅ Setup complete! Credentials saved to .env');
        console.log('\nTest it:');
        console.log('  npm run dev:calendar');
    } catch (error) {
        console.error('\n❌ Setup failed:', error);
        process.exit(1);
    }
}

main();
