import Logger from './Logger';
import CommandExecutor from './Service/CommandExecutor';
import HueController from './Controller/HueController';
import SpotifyController from './Controller/SpotifyController';
import Orchestrator from './Service/Orchestrator';
import { initTestLights } from './Entity/Light';
// import { initLights } from './Entity/Light';
import Listener from './Service/Listener';

async function main() {
    const commandExecutor = new CommandExecutor();
    const hueController = new HueController();
    await hueController.init();

    const spotifyController = new SpotifyController();
    const entities = await initTestLights(hueController);
    Logger.debug('Modules imported');
    // const entities = await initLights(hueController);
    commandExecutor.init(entities, spotifyController);
    const orchestrator = new Orchestrator(commandExecutor);
    Logger.debug('Modules initialisation');
    new Listener(commandExecutor, orchestrator).init();
    Logger.info('Initialisation of the "Yui" application completed');
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
