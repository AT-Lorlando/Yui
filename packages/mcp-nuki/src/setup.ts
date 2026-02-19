import path from 'path';
import fs from 'fs';
import axios from 'axios';
import NukiBridge from './NukiBridge';

const ROOT_ENV_PATH = path.resolve(__dirname, '../../../.env');

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

async function main() {
    console.log('=== Yui — Nuki Bridge Setup ===\n');

    // 1. Ask for bridge host and port
    const host = process.argv[2];
    const port = process.argv[3] || '8080';

    if (!host) {
        console.error(
            'Usage: npm run setup:nuki -- <bridge-ip> [port]\n' +
                'Example: npm run setup:nuki -- 192.168.1.50 8080\n\n' +
                'Find your Nuki Bridge IP in the Nuki app under:\n' +
                '  Manage Bridge > IP address',
        );
        process.exit(1);
    }

    console.log(`Bridge: http://${host}:${port}`);

    // 2. Create token via /auth (requires button press)
    const token = await NukiBridge.createToken(host, port);
    console.log(`Token:  ${token}`);

    // 3. Write credentials to root .env
    updateEnvFile('NUKI_HOST', host);
    updateEnvFile('NUKI_PORT', port);
    updateEnvFile('NUKI_TOKEN', token);
    console.log(`\nCredentials written to ${ROOT_ENV_PATH}`);

    // 4. Validate by listing locks
    console.log('\nValidating connection...');
    const baseUrl = `http://${host}:${port}`;
    const response = await axios.get(`${baseUrl}/list?token=${token}`);
    const locks = Array.isArray(response.data) ? response.data : [];

    // 5. Summary
    console.log('\n=== Setup complete ===');
    console.log(`Bridge: http://${host}:${port}`);
    console.log(`Token:  ${token}`);
    console.log(`Locks:  ${locks.length}`);
    for (const lock of locks) {
        console.log(`  - ${lock.name} (id: ${lock.nukiId}, type: ${lock.deviceType})`);
    }
    console.log('\nYou can now run: npm run dev:nuki');
}

main().catch((err) => {
    console.error('\nSetup failed:', err.message);
    process.exit(1);
});
