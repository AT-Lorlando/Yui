import Logger from './Logger';
import CommandExecutor from './Service/CommandExecutor';
import HueController from './Controller/HueController';
import SpotifyController from './Controller/SpotifyController';
import Orchestrator from './Service/Orchestrator';
import { initTestLights } from './Entity/Light';
// import { initLights } from './Entity/Light';

async function main() {
    const commandExecutor = new CommandExecutor();
    const hueController = new HueController();
    await hueController.init();

    const spotifyController = new SpotifyController();
    const entities = await initTestLights(hueController);
    // const entities = await initLights(hueController);
    commandExecutor.init(entities, spotifyController);
    const orchestrator = new Orchestrator(commandExecutor);
    const order = {
        content:
            'Allume la lumière du bureau a 10%, puis, quand tu recevra le résultat, éteint la lumière du bureau',
        timestamp: Date.now().toString(),
    };
    await orchestrator.getRouterQueriesFromOrder(order);
}

main()
    .then(() => {
        Logger.info('Yui is ready to use');
    })
    .catch((error) => {
        Logger.error(
            `Error during the initialisation of Yui: ${error.message}`,
        );
    });
