import HueController from '../src/Controller/HueController';
import { Light } from '../src/Entity/Light';

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
