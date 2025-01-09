import HueController from '../Controller/HueController';
import Entity from './Entity';
import Logger from '../Logger';

export class Light extends Entity {
    constructor(
        public name: string,
        public id: number,
        public room: string,
        private hueController: HueController,
    ) {
        super(name, id, room);
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

    async setState(property: string, value: string): Promise<void> {
        switch (property) {
            case 'luminosity':
                await this.set_luminosity(parseInt(value, 10));
                break;
            case 'color':
                await this.set_color(value);
                break;
            case 'power':
                if (value === '1') {
                    await this.turnon();
                } else if (value === '0') {
                    await this.turnoff();
                }
                break;
            default:
                throw new Error(`Property ${property} not found`);
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
