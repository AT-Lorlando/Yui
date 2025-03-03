import Logger from './Logger';
import { testLogger } from './Logger';
import { initLights } from './Entity/Light';
import { initSpeakers } from './Entity/Speaker';
import CommandExecutor from './Service/CommandExecutor';
import HueController from './Controller/HueController';
import SpotifyController from './Controller/SpotifyController';
// import Listener from './Service/Listener';

async function main() {
    testLogger();
    Logger.info('Starting the "Yui" application');
    Logger.debug('Importing modules');

    // const commandRecognition = new CommandRecognition();
    const commandExecutor = new CommandExecutor();
    const hueController = new HueController();
    const spotifyController = new SpotifyController();
    // const listener = new Listener();

    Logger.debug('Modules imported');
    Logger.debug('Modules initialisation');

    await spotifyController.init();
    await hueController.init();
    const entities = await Promise.all([
        initLights(hueController),
        initSpeakers(spotifyController),
    ]).then((entities) => entities.flat());
    // await commandRecognition.init()

    await commandExecutor.init(entities, spotifyController);
    // await listener.init(commandExecutor);

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
