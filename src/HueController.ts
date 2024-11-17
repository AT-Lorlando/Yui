import { v3, discovery } from 'node-hue-api';
import { BridgeDiscoveryResponse } from 'node-hue-api/dist/esm/api/discovery/discoveryTypes';
import Logger from './Logger';
import { env } from './env';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class HueController {
    private api: any;
    private appName: string;
    private deviceName: string;

    constructor() {
        this.appName = 'Yui';
        this.deviceName = 'Sukoshi';
    }

    async init() {
        try {
            await this.connect();
        } catch (error) {
            Logger.error(
                `Error during the initialisation of HueController: ${error}`,
            );
            throw new Error('Error during the initialisation of HueController');
        }
    }

    async connect() {
        let bridge;
        if (env.HUE_BRIDGE_IP) {
            bridge = { ipaddress: env.HUE_BRIDGE_IP };
            Logger.info(`Using existing bridge IP: ${bridge.ipaddress}`);
        } else {
            bridge = await this.discoverBridge();
            if (!bridge) {
                throw new Error('No bridge found');
            }
        }

        let user;
        if (env.HUE_USERNAME) {
            user = { username: env.HUE_USERNAME };
            Logger.info(`Using existing username: ${user.username}`);
        } else {
            const result = await this.createUser(bridge);
            if (!result) {
                throw new Error('Error during the creation of the user');
            }
            user = result.user;
            Logger.info(`User created - Username: ${user.username}`);
            Logger.info(
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
            Logger.info(`Bridge found at IP address: ${bridge.ipaddress}`);

            return bridge;
        } catch (error) {
            Logger.error('Error during the discovery of the bridge:', error);
        }
    }

    private async createUser(
        bridge: BridgeDiscoveryResponse,
    ): Promise<{ api: any; user: any } | undefined> {
        try {
            const api = await v3.api.createLocal(bridge.ipaddress).connect();

            Logger.info(
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

            Logger.info('User created.' + JSON.stringify(user));

            return { api, user };
        } catch (error) {
            Logger.error('Error during the creation of the user:', error);
        }
    }

    public async getAllLights(): Promise<any[]> {
        try {
            if (!this.api) {
                throw new Error('Hue API not initialized.');
            }
            const returnLights: any[] = [];
            const lights = await this.api.lights.getAll();
            lights.map((light: any) => {
                Logger.debug(`Light found: ID=${light.id}, Name=${light.name}`);
                returnLights.push({
                    id: light.id,
                    name: light.name,
                    state: light.state,
                });
            });
            if (returnLights.length === 0) {
                throw new Error('No lights found.');
            }
            return returnLights;
        } catch (error: any) {
            Logger.error('Error getting all lights');
            throw error;
        }
    }

    public async getLightById(id: number): Promise<any> {
        try {
            if (!this.api) {
                throw new Error('Hue API not initialized.');
            }
            const light = await this.api.lights.getLight(id);
            Logger.debug(`Light found: ID=${light.id}, Name=${light.name}`);
            if (!light) {
                throw new Error('No light found.');
            }
            return light;
        } catch (error: any) {
            Logger.error('Error getting light by ID');
            throw error;
        }
    }

    public async getGroupsByType(type: string): Promise<any[]> {
        try {
            if (!this.api) {
                throw new Error('Hue API not initialized.');
            }
            const returnGroup: any[] = [];
            const groups = await this.api.groups.getAll();
            groups.map((group: any) => {
                Logger.debug(`Group found: ID=${group.id}, Name=${group.name}`);
                if (group.type === type) {
                    returnGroup.push({
                        id: group.id,
                        name: group.name,
                        lights: group.lights,
                    });
                }
            });
            if (returnGroup.length === 0) {
                throw new Error('No groups found.');
            }
            return returnGroup;
        } catch (error: any) {
            Logger.error('Error getting groups by type');
            throw error;
        }
    }

    public async setLightState(lightId: number, on: boolean): Promise<void> {
        try {
            if (!this.api) {
                throw new Error(
                    'Hue API not initialized. Call connect() first.',
                );
            }
            await this.getLightById(lightId).catch((error: any) => {
                throw error;
            });

            const lightState = new v3.lightStates.LightState().on(on);

            await this.api.lights.setLightState(lightId, lightState);
            Logger.info(`Light ${lightId} turned ${on ? 'on' : 'off'}`);
        } catch (error: any) {
            Logger.error(
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
            await this.getLightById(lightId).catch((error) => {
                throw error;
            });

            const lightState = new v3.lightStates.LightState()
                .on()
                .brightness(brightness);

            await this.api.lights.setLightState(lightId, lightState);
            Logger.info(`Light ${lightId} brightness set to ${brightness}`);
        } catch (error) {
            Logger.error(
                `Error setting light brightness for light ${lightId}:`,
                error,
            );
            throw error;
        }
    }

    public async setLightColor(lightId: number, color: string): Promise<void> {
        try {
            if (!this.api) {
                throw new Error(
                    'Hue API not initialized. Call connect() first.',
                );
            }

            await this.getLightById(lightId).catch((error: any) => {
                throw error;
            });

            function hexToRgb(hex: string) {
                const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(
                    hex,
                );
                if (result === null) {
                    throw new Error('Error converting hex to RGB');
                }
                return {
                    r: parseInt(result[1], 16),
                    g: parseInt(result[2], 16),
                    b: parseInt(result[3], 16),
                };
            }

            function rgbToHueSat(rgb: { r: number; g: number; b: number }) {
                const r = rgb.r / 255;
                const g = rgb.g / 255;
                const b = rgb.b / 255;

                const max = Math.max(r, g, b),
                    min = Math.min(r, g, b);
                let h,
                    s = (max + min) / 2;
                const l = s;
                if (max === min) {
                    h = s = 0; // achromatic
                } else {
                    const d = max - min;
                    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                    switch (max) {
                        case r:
                            h = (g - b) / d + (g < b ? 6 : 0);
                            break;
                        case g:
                            h = (b - r) / d + 2;
                            break;
                        case b:
                            h = (r - g) / d + 4;
                            break;
                    }
                    if (h === undefined) {
                        throw new Error('Error converting RGB to HSL');
                    }
                    h /= 6;
                }

                return {
                    hue: Math.round(h * 65535),
                    sat: Math.round(s * 254),
                };
            }
            const newColor = rgbToHueSat(hexToRgb(color));
            const hue = newColor.hue;
            const sat = newColor.sat;
            Logger.debug(`Hue: ${hue}, Sat: ${sat}`);
            const lightState = new v3.lightStates.LightState()
                .on()
                .hue(hue)
                .sat(sat);
            Logger.info(
                `Call api with lightId: ${lightId}, lightState: ${lightState}`,
            );
            await this.api.lights
                .setLightState(lightId, lightState)
                .catch((error: any) => {
                    throw error;
                });
            Logger.info(`Light ${lightId} color set to ${color}`);
        } catch (error: any) {
            Logger.error(
                `Error setting light color for light ${lightId}:`,
                error,
            );
        }
    }

    public async getLightState(lightId: number): Promise<any> {
        try {
            if (!this.api) {
                throw new Error('Hue API not initialized.');
            }
            const light = await this.getLightById(lightId).catch(
                (error: any) => {
                    throw error;
                },
            );
            const lightState = light.state;
            lightState.bri = Math.round((lightState.bri / 254) * 100);
            return lightState;
        } catch (error: any) {
            Logger.error('Error getting light state');
            throw error;
        }
    }
}
