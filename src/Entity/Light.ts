import HueController from '../Controller/HueController';
import Entity from './Entity';
import Logger from '../Logger';
import { Response } from '../types/types';

export class Light extends Entity {
    constructor(
        public name: string,
        public id: number,
        public room: string,
        private hueController: HueController,
    ) {
        super(name, id, room);
    }

    async turnoff(): Promise<Response> {
        try {
            await this.hueController.setLightState(this.id, false);
            return { status: 'success', message: 'Light turned off' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async turnon(): Promise<Response> {
        try {
            await this.hueController.setLightState(this.id, true);
            return { status: 'success', message: 'Light turned on' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async set_luminosity(luminosity: number): Promise<Response> {
        try {
            const state = await this.hueController.getLightState(this.id);
            if (state.on === false) {
                await this.hueController.setLightState(this.id, true);
            }
            await this.hueController.setLightBrightness(this.id, luminosity);
            return { status: 'success', message: 'Luminosity set' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async set_color(color: string): Promise<Response> {
        try {
            await this.hueController.setLightColor(this.id, color);
            return { status: 'success', message: 'Color set' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async lower_luminosity(): Promise<Response> {
        try {
            const state = await this.hueController.getLightState(this.id);
            const luminosity = state.bri;
            await this.hueController.setLightBrightness(
                this.id,
                luminosity - 10,
            );
            return { status: 'success', message: 'Luminosity lowered' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async raise_luminosity(): Promise<Response> {
        try {
            const state = await this.hueController.getLightState(this.id);
            const luminosity = state.bri;
            await this.hueController.setLightBrightness(
                this.id,
                luminosity + 10,
            );
            return { status: 'success', message: 'Luminosity raised' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async setState(property: string, value: string): Promise<Response> {
        try {
            switch (property) {
                case 'luminosity':
                    return await this.set_luminosity(parseInt(value, 10));
                case 'color':
                    return await this.set_color(value);
                case 'power':
                    if (value === '1') {
                        return await this.turnon();
                    } else if (value === '0') {
                        return await this.turnoff();
                    }
                    throw new Error(
                        `Value ${value} not valid for property ${property}`,
                    );
                default:
                    throw new Error(`Property ${property} not found`);
            }
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }
}

export async function initLights(
    hueController: HueController,
): Promise<Entity[]> {
    const lightsGroups = await hueController.getGroupsByType('Room');
    const lightPromises: Promise<Entity>[] = [];
    lightsGroups.forEach((group) => {
        group.lights.forEach((lightID: number) => {
            lightPromises.push(
                hueController.getLightById(lightID).then((light) => {
                    const newLight = new Light(
                        light.name,
                        light.id,
                        group.name,
                        hueController,
                    );
                    Logger.info(
                        `Entities Initialisation: ${light.id}: Light '${light.name}' in ${group.name} added`,
                    );
                    return newLight;
                }),
            );
        });
    });
    return await Promise.all(lightPromises);
}

export async function initTestLights(
    hueController: HueController,
): Promise<Entity[]> {
    return [
        new Light('Plafond', 101, 'Living Room', hueController),
        new Light('Lampadaire', 102, 'Living Room', hueController),
        new Light('Cuisine', 103, 'Living Room', hueController),
        new Light('Plafond', 104, 'Chamber', hueController),
        new Light('Chevet', 105, 'Chamber', hueController),
        new Light('Bureau', 106, 'Desk', hueController),
    ];
}
