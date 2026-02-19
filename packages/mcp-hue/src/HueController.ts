import { v3 } from 'node-hue-api';
import Logger from './logger';

export default class HueController {
    private api: any;

    constructor(api: any) {
        this.api = api;
    }

    public async getAllGroups(): Promise<
        { name: string; lights: string[] }[]
    > {
        const groups = await this.api.groups.getAll();
        return groups
            .filter((g: any) => g.type === 'Room')
            .map((g: any) => ({ name: g.name, lights: g.lights }));
    }

    public async getAllLights(): Promise<any[]> {
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
    }

    public async getLightById(id: number): Promise<any> {
        const light = await this.api.lights.getLight(id);
        Logger.debug(`Light found: ID=${light.id}, Name=${light.name}`);
        if (!light) {
            throw new Error('No light found.');
        }
        return light;
    }

    public async setLightState(lightId: number, on: boolean): Promise<void> {
        await this.getLightById(lightId);
        const lightState = new v3.lightStates.LightState().on(on);
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(`Light ${lightId} turned ${on ? 'on' : 'off'}`);
    }

    public async setLightBrightness(
        lightId: number,
        brightness: number,
    ): Promise<void> {
        await this.getLightById(lightId);
        const lightState = new v3.lightStates.LightState()
            .on()
            .brightness(brightness);
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(`Light ${lightId} brightness set to ${brightness}`);
    }

    public async setLightColor(lightId: number, color: string): Promise<void> {
        await this.getLightById(lightId);

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
                h = s = 0;
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
        const lightState = new v3.lightStates.LightState()
            .on()
            .hue(newColor.hue)
            .sat(newColor.sat);
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(`Light ${lightId} color set to ${color}`);
    }

    public async getLightState(lightId: number): Promise<any> {
        const light = await this.getLightById(lightId);
        return light.state;
    }
}
