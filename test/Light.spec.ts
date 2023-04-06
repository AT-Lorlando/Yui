import HueController from '../src/HueController';
import { Light } from '../src/Entity';

jest.mock('../src/HueController');

describe('Light controller', () => {
    let hueController: HueController;
    let light: Light;

    beforeEach(() => {
        hueController = new HueController();
        light = new Light('Test Light', 1, 'Living Room', hueController);

        (hueController.setLightBrightness as jest.Mock).mockResolvedValue(
            undefined,
        );
        (hueController.setLightColor as jest.Mock).mockResolvedValue(undefined);
        (hueController.setLightState as jest.Mock).mockResolvedValue(undefined);
        (hueController.getLightState as jest.Mock).mockResolvedValue({
            bri: 50,
        });
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    test('specialCommand("lower_luminosity") should lower the brightness', async () => {
        (hueController.getLightState as jest.Mock).mockResolvedValue({
            bri: 100,
        });

        await light.specialCommand('lower_luminosity');
        expect(hueController.setLightBrightness).toHaveBeenCalledWith(1, 90);
    });

    test('specialCommand("raise_luminosity") should raise the brightness', async () => {
        await light.specialCommand('raise_luminosity');
        expect(hueController.setLightBrightness).toHaveBeenCalledWith(1, 60);
    });

    test('specialCommand("set_luminosity") should set the brightness', async () => {
        await light.specialCommand('set_luminosity', [70]);
        expect(hueController.setLightBrightness).toHaveBeenCalledWith(1, 70);
    });

    test('specialCommand("set_color") should set the color', async () => {
        await light.specialCommand('set_color', ['red']);
        expect(hueController.setLightColor).toHaveBeenCalledWith(1, 'red');
    });

    test('shutdown() should turn off the light', async () => {
        await light.shutdown();
        expect(hueController.setLightState).toHaveBeenCalledWith(1, false);
    });

    test('turnon() should turn on the light', async () => {
        await light.turnon();
        expect(hueController.setLightState).toHaveBeenCalledWith(1, true);
    });

    // Ajoutez d'autres tests pour les autres commandes et méthodes si nécessaire
});

describe('E2E Test', () => {
    let hueController: HueController;
    let light: Light;

    beforeAll(async () => {
        // Assurez-vous que hueController est correctement initialisé
        console.log('Initializing hueController...');
        hueController = new HueController();
        await hueController.init();

        // Testez si getLightById retourne une promesse
        console.log('Testing getLightById...');
        const getLightByIdResult = hueController.getLightById(4);
        console.log('getLightById result:', getLightByIdResult);

        // Si getLightByIdResult est une promesse, vous pouvez ajouter .catch
        if (getLightByIdResult instanceof Promise) {
            console.log('getLightById returned a promise, calling .catch...');
            const testLight = await getLightByIdResult.catch((error) => {
                console.log(error);
                throw error;
            });
        } else {
            console.log('getLightById did not return a promise.');
        }
        light = new Light('Test Light', 4, 'Living Room', hueController);
    });

    test('turnon should turn on the light', async () => {
        await light.turnon();

        const updatedLightState = await hueController.getLightState(light.id);

        expect(updatedLightState.on).toBe(true);
    });

    test('turnoff should turn off the light', async () => {
        // Turn off the light
        await light.shutdown();

        // Get the updated light state
        const updatedLightState = await hueController.getLightState(light.id);
        // Check if the light is off
        expect(updatedLightState.on).toBe(false);
    });

    test('set_luminosity should set the brightness', async () => {
        await light.set_luminosity(50);

        const updatedLightState = await hueController.getLightState(light.id);

        expect(updatedLightState.bri).toBe(50);
    });

    test('set_color should set the color', async () => {
        await light.set_color('red');

        const updatedLightState = await hueController.getLightState(light.id);

        expect(updatedLightState.colormode).toBe('xy');
    });

    test('lower_luminosity should lower the brightness', async () => {
        await light.lower_luminosity();

        const updatedLightState = await hueController.getLightState(light.id);

        expect(updatedLightState.bri).toBe(40);
    });

    test('raise_luminosity should raise the brightness', async () => {
        await light.raise_luminosity();

        const updatedLightState = await hueController.getLightState(light.id);

        expect(updatedLightState.bri).toBe(50);
    });
});
