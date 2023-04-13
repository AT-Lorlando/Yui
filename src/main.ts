import { logger, testLogger } from './logger';
import { initEntitiesFromAPI } from './Entity';
import CommandExecutor from './CommandExecutor';
import GPT3Request from './GPT3Request';
import HueController from './HueController';
import SpotifyController from './SpotifyController';
import Listener from './Listener';

async function main() {
    testLogger();
    logger.info('Starting the "Yui" application');
    logger.debug('Importing modules');

    // const commandRecognition = new CommandRecognition();
    const commandExecutor = new CommandExecutor();
    const gpt3Request = new GPT3Request();
    const hueController = new HueController();
    const spotifyController = new SpotifyController();
    const listener = new Listener();

    logger.debug('Modules imported');

    logger.debug('Modules initialisation');

    await listener.init(commandExecutor, spotifyController).catch((error) => {
        logger.error(`Error during the initialisation of Listener: ${error}`);
        throw new Error('Error during the initialisation of Listener');
    });

    await spotifyController.init().catch((error) => {
        logger.error(
            `Error during the initialisation of SpotifyController: ${error}`,
        );
        throw new Error('Error during the initialisation of SpotifyController');
    });

    await hueController.init().catch((error) => {
        logger.error(
            `Error during the initialisation of HueController: ${error}`,
        );
        throw new Error('Error during the initialisation of HueController');
    });

    const entities = await initEntitiesFromAPI(
        hueController,
        spotifyController,
    ).catch((error) => {
        logger.error(
            `Error during the initialisation of entities from API: ${error}`,
        );
        throw new Error('Error during the initialisation of entities from API');
    });

    if (entities === undefined || entities.length === 0) {
        throw new Error('Entities are undefined');
    }

    // await commandRecognition.init().catch((error) => {
    //     logger.error(`Error during the initialisation of commandRecognition: ${error}`);
    // });

    await commandExecutor.init(entities, gpt3Request).catch((error) => {
        logger.error(
            `Error during the initialisation of CommandExecutor: ${error}`,
        );
        throw new Error('Error during the initialisation of CommandExecutor');
    });

    await gpt3Request.init(commandExecutor, entities).catch((error) => {
        logger.error(
            `Error during the initialisation of gpt3Request: ${error}`,
        );
        throw new Error('Error during the initialisation of gpt3Request');
    });

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
