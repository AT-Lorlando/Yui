import HueController from '../HueController';
import { Entity } from '../Entity';

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
