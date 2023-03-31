import { v3 } from 'node-hue-api';
import { BridgeDiscoveryResponse } from 'node-hue-api/dist/esm/api/discovery/discoveryTypes';
import { logger } from './logger';

const appName = 'Yui';
const deviceName = 'Sukoshi';

async function discoverBridge() {
    try {
        const searchResults = await v3.discovery.nupnpSearch();

        if (searchResults.length === 0) {
            throw new Error(
                'No bridges found. Make sure your bridge is powered on and connected to the network.',
            );
        }

        const bridge = searchResults[0];
        logger.info(`Bridge found at IP address: ${bridge.ipaddress}`);

        return bridge;
    } catch (error) {
        logger.error('Error during the discovery of the bridge:', error);
    }
}

async function createUser(bridge: BridgeDiscoveryResponse) {
    try {
        const api = await v3.api.createLocal(bridge.ipaddress).connect();
        const user = await api.users.createUser(appName, deviceName);

        logger.info('User created.' + JSON.stringify(user));

        return { api, user };
    } catch (error) {
        logger.error('Error during the creation of the user:', error);
    }
}

async function main() {
    const bridge = await discoverBridge();
    if (!bridge) {
        throw new Error('No bridge found');
    }
    const result = await createUser(bridge);

    if (!result) {
        throw new Error('Error during the creation of the user');
    }
    const { api, user } = result;
    logger.info(`User created - Username: ${user.username}`);
    logger.info(`Press link button on the bridge to create a user (if needed)`);
    // Utilisez l'API ici pour contrôler vos lumières
}

main();
