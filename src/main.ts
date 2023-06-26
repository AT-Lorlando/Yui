import { logger, testLogger } from './logger';
import { initEntities } from './Entity';
import CommandExecutor from './CommandExecutor';
import GPTQueryLauncher from './GPTQueryLauncher';
import HueController from './HueController';
import SpotifyController from './SpotifyController';
import Listener from './Listener';

async function main() {
    testLogger();
    logger.info('Starting the "Yui" application');
    logger.debug('Importing modules');

    // const commandRecognition = new CommandRecognition();
    const commandExecutor = new CommandExecutor();
    const GPTQL = new GPTQueryLauncher();
    const hueController = new HueController();
    const spotifyController = new SpotifyController();
    const listener = new Listener();

    logger.debug('Modules imported');
    logger.debug('Modules initialisation');

    await spotifyController.init();
    await hueController.init();
    const entities = await initEntities(hueController, spotifyController);
    // await commandRecognition.init()

    await commandExecutor.init(entities, spotifyController, GPTQL);
    await GPTQL.init(commandExecutor);
    await listener.init(commandExecutor);

    logger.info('Initialisation of the "Yui" application completed');
}

main()
    .then(() => {
        logger.info('Yui is ready to use');
    })
    .catch((error) => {
        logger.error(
            `Error during the initialisation of Yui: ${error.message}`,
        );
    });
