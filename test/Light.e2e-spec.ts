import HueController from '../src/HueController';
import { Light } from '../src/Entity';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('E2E Test', () => {
    let hueController: HueController;
    let light: Light;
    const lightBrightnessToSet = 100;

    beforeAll(async () => {
        hueController = new HueController();
        await hueController.init();
        console.log('Hue Controller initialized');

        light = new Light('Test Light', 4, 'Living Room', hueController);
    });

    test('turnon should turn on the light', async () => {
        await light.turnon();

        const updatedLightState = await hueController.getLightState(light.id);

        expect(updatedLightState.on).toBe(true);
    });

    test('turnoff should turn off the light', async () => {
        // Turn off the light
        await light.turnoff();

        // Get the updated light state
        const updatedLightState = await hueController.getLightState(light.id);
        // Check if the light is off
        expect(updatedLightState.on).toBe(false);
    });

    test('set_luminosity should set the brightness', async () => {
        await light.set_luminosity(lightBrightnessToSet);

        const updatedLightState = await hueController.getLightState(light.id);
        expect(updatedLightState.bri).toBe(lightBrightnessToSet);
    });

    test('set_color should set the color', async () => {
        await light.set_color('red');

        const updatedLightState = await hueController.getLightState(light.id);

        expect(updatedLightState.colormode).toBe('xy');
    });

    test('lower_luminosity should lower the brightness', async () => {
        await light.lower_luminosity();

        const updatedLightState = await hueController.getLightState(light.id);

        expect(updatedLightState.bri).toBe(lightBrightnessToSet - 10);
    });

    test('raise_luminosity should raise the brightness', async () => {
        await light.raise_luminosity();

        const updatedLightState = await hueController.getLightState(light.id);

        expect(updatedLightState.bri).toBe(lightBrightnessToSet);
    });
});
