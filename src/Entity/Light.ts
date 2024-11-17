import HueController from '../HueController';
import Entity from './Entity';
import { logger } from '../logger';

export class Light extends Entity {
    private hueController: HueController;
    constructor(
        name: string,
        public id: number,
        public room: string,
        hueController: HueController,
    ) {
        super(name, id, room);
        this.hueController = hueController;
    }

    async turnoff(): Promise<void> {
        await this.hueController
            .setLightState(this.id, false)
            .catch((error) => {
                throw error;
            });
    }

    async turnon(): Promise<void> {
        await this.hueController.setLightState(this.id, true).catch((error) => {
            throw error;
        });
    }

    async set_luminosity(luminosity: number): Promise<void> {
        const state = await this.hueController.getLightState(this.id);
        if (state.on === false) {
            await this.hueController.setLightState(this.id, true);
        }
        await this.hueController
            .setLightBrightness(this.id, luminosity)
            .catch((error) => {
                throw error;
            });
    }

    async set_color(color: string): Promise<void> {
        await this.hueController
            .setLightColor(this.id, color)
            .catch((error) => {
                throw error;
            });
    }

    async lower_luminosity(): Promise<void> {
        const state = await this.hueController
            .getLightState(this.id)
            .catch((error) => {
                throw error;
            });
        const luminosity = state.bri;
        await this.hueController
            .setLightBrightness(this.id, luminosity - 10)
            .catch((error) => {
                throw error;
            });
    }

    async raise_luminosity(): Promise<void> {
        const state = await this.hueController
            .getLightState(this.id)
            .catch((error) => {
                throw error;
            });
        const luminosity = state.bri;
        await this.hueController
            .setLightBrightness(this.id, luminosity + 10)
            .catch((error) => {
                throw error;
            });
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
                    logger.info(
                        `Entities Initialisation: ${light.id}: Light '${light.name}' in ${group.name} added`,
                    );
                    return newLight;
                }),
            );
        });
    });
    return await Promise.all(lightPromises);
}
