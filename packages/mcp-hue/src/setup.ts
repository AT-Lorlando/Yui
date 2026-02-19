import path from 'path';
import fs from 'fs';
import { v3 } from 'node-hue-api';
import HueBridge from './HueBridge';

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
    console.log('=== Yui — Hue Bridge Setup ===\n');

    // 1. Discover bridge
    const bridgeIp = await HueBridge.discoverBridge();
    console.log(`Bridge IP: ${bridgeIp}`);

    // 2. Create user
    const username = await HueBridge.createUser(bridgeIp);
    console.log(`Username:  ${username}`);

    // 3. Write credentials to root .env
    updateEnvFile('HUE_BRIDGE_IP', bridgeIp);
    updateEnvFile('HUE_USERNAME', username);
    console.log(`\nCredentials written to ${ROOT_ENV_PATH}`);

    // 4. Validate by connecting and discovering lights
    console.log('\nValidating connection...');
    const api = await v3.api.createLocal(bridgeIp).connect(username);

    const groups = await api.groups.getAll();
    const rooms = groups.filter((g: any) => g.type === 'Room');
    const lights = await api.lights.getAll();

    // 5. Summary
    console.log('\n=== Setup complete ===');
    console.log(`Bridge:  ${bridgeIp}`);
    console.log(`User:    ${username}`);
    console.log(`Rooms:   ${rooms.length}`);
    console.log(`Lights:  ${lights.length}`);
    console.log('\nYou can now run: npm run dev:hue');
}

main().catch((err) => {
    console.error('\nSetup failed:', err.message);
    process.exit(1);
});
