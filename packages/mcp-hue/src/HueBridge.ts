import { v3, discovery } from 'node-hue-api';
import Logger from './logger';

const APP_NAME = 'Yui';
const DEVICE_NAME = 'Sukoshi';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class HueBridge {
    /**
     * Prod mode: connect using env vars. Throws if HUE_BRIDGE_IP or HUE_USERNAME are missing.
     */
    static async connect(): Promise<any> {
        const bridgeIp = process.env.HUE_BRIDGE_IP;
        const username = process.env.HUE_USERNAME;

        if (!bridgeIp) {
            throw new Error(
                'HUE_BRIDGE_IP is not set. Run "npm run setup:hue" to configure the bridge.',
            );
        }
        if (!username) {
            throw new Error(
                'HUE_USERNAME is not set. Run "npm run setup:hue" to configure the bridge.',
            );
        }

        Logger.info(`Connecting to bridge at ${bridgeIp}`);
        return v3.api.createLocal(bridgeIp).connect(username);
    }

    /**
     * Discover a Hue bridge on the local network via nupnp.
     */
    static async discoverBridge(): Promise<string> {
        Logger.info('Searching for Hue bridge on the network...');
        const searchResults = await discovery.nupnpSearch();

        if (searchResults.length === 0) {
            throw new Error(
                'No bridges found. Make sure your bridge is powered on and connected to the network.',
            );
        }

        const bridge = searchResults[0];
        Logger.info(`Bridge found at IP address: ${bridge.ipaddress}`);
        return bridge.ipaddress;
    }

    /**
     * Create a new API user on the bridge. Requires the link button to be pressed.
     * Retries up to 6 times (30 seconds total).
     */
    static async createUser(bridgeIp: string): Promise<string> {
        const api = await v3.api.createLocal(bridgeIp).connect();

        Logger.info(
            'Press the link button on the bridge within the next 30 seconds.',
        );

        let user: any;
        let attempts = 0;
        const maxAttempts = 6;

        while (!user && attempts < maxAttempts) {
            try {
                user = await api.users.createUser(APP_NAME, DEVICE_NAME);
            } catch {
                attempts += 1;
                await sleep(5 * 1000);
            }
        }

        if (!user) {
            throw new Error('Failed to create user. Please try again.');
        }

        Logger.info(`User created — Username: ${user.username}`);
        return user.username;
    }
}
