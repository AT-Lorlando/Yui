import { v3, discovery } from 'node-hue-api';
import { BridgeDiscoveryResponse } from 'node-hue-api/dist/esm/api/discovery/discoveryTypes';
import { logger } from './logger';
import { env } from './env';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HueController {
    private api: any;
    private appName: string;
    private deviceName: string;

    constructor() {
        this.appName = 'Yui';
        this.deviceName = 'Sukoshi';
    }

    async connect() {
        let bridge;
        if (env.HUE_BRIDGE_IP) {
            bridge = { ipaddress: env.HUE_BRIDGE_IP };
            logger.info(`Using existing bridge IP: ${bridge.ipaddress}`);
        } else {
            bridge = await this.discoverBridge();
            if (!bridge) {
                throw new Error('No bridge found');
            }
        }

        let user;
        if (env.HUE_USERNAME) {
            user = { username: env.HUE_USERNAME };
            logger.info(`Using existing username: ${user.username}`);
        } else {
            const result = await this.createUser(bridge);
            if (!result) {
                throw new Error('Error during the creation of the user');
            }
            user = result.user;
            logger.info(`User created - Username: ${user.username}`);
            logger.info(
                `Press link button on the bridge to create a user (if needed)`,
            );
        }

        this.api = await v3.api
            .createLocal(bridge.ipaddress)
            .connect(user.username);
    }

    private async discoverBridge() {
        try {
            const searchResults = await discovery.nupnpSearch();

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

    private async createUser(
        bridge: BridgeDiscoveryResponse,
    ): Promise<{ api: any; user: any } | undefined> {
        try {
            const api = await v3.api.createLocal(bridge.ipaddress).connect();

            logger.info(
                'Press the link button on the bridge within the next 30 seconds.',
            );

            let user;
            let attempts = 0;
            const maxAttempts = 6; // 30 seconds (6 * 5 seconds)

            while (!user && attempts < maxAttempts) {
                try {
                    user = await api.users.createUser(
                        this.appName,
                        this.deviceName,
                    );
                } catch (error) {
                    attempts += 1;
                    await sleep(5 * 1000);
                }
            }

            if (!user) {
                throw new Error('Failed to create user. Please try again.');
            }

            logger.info('User created.' + JSON.stringify(user));

            return { api, user };
        } catch (error) {
            logger.error('Error during the creation of the user:', error);
        }
    }

    public async getAllLights(): Promise<void> {
        try {
            if (!this.api) {
                throw new Error('Hue API not initialized.');
            }

            const lights = await this.api.lights.getAll();
            lights.forEach((light: any) => {
                logger.info(`Light found: ID=${light.id}, Name=${light.name}`);
            });
        } catch (error: any) {
            logger.error('Error getting all lights:', error.message);
        }
    }

    public async setLightState(lightId: number, on: boolean): Promise<void> {
        try {
            if (!this.api) {
                throw new Error(
                    'Hue API not initialized. Call connect() first.',
                );
            }

            const lightState = new v3.lightStates.LightState().on(on);

            await this.api.lights.setLightState(lightId, lightState);
            logger.info(`Light ${lightId} turned ${on ? 'on' : 'off'}`);
        } catch (error: any) {
            logger.error(
                `Error setting light state for light ${lightId}:`,
                error.message,
            );
        }
    }

    public async setLightBrightness(
        lightId: number,
        brightness: number,
    ): Promise<void> {
        try {
            if (!this.api) {
                throw new Error(
                    'Hue API not initialized. Call connect() first.',
                );
            }

            const lightState = new v3.lightStates.LightState().brightness(
                brightness,
            );

            await this.api.lights.setLightState(lightId, lightState);
            logger.info(`Light ${lightId} brightness set to ${brightness}`);
        } catch (error: any) {
            logger.error(
                `Error setting light brightness for light ${lightId}:`,
                error.message,
            );
        }
    }

    public async setLightColor(lightId: number, color: string): Promise<void> {
        try {
            if (!this.api) {
                throw new Error(
                    'Hue API not initialized. Call connect() first.',
                );
            }

            const hue = parseInt(color, 16);
            const sat = 100;

            const lightState = new v3.lightStates.LightState()
                .on()
                .hue(hue)
                .sat(sat);

            await this.api.lights.setLightState(lightId, lightState);
            logger.info(`Light ${lightId} color set to ${color}`);
        } catch (error: any) {
            logger.error(
                `Error setting light color for light ${lightId}:`,
                error.message,
            );
        }
    }
}
