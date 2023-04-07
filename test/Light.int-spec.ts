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

    test('turnoff() should turn off the light', async () => {
        await light.turnoff();
        expect(hueController.setLightState).toHaveBeenCalledWith(1, false);
    });

    test('turnon() should turn on the light', async () => {
        await light.turnon();
        expect(hueController.setLightState).toHaveBeenCalledWith(1, true);
    });

    // Ajoutez d'autres tests pour les autres commandes et méthodes si nécessaire
});
