import { logger, testLogger } from './logger';
import {
    initEntitiesFromJson,
    Entity,
    initEntitiesFromAPI,
    Light,
} from './Entity';
import ManualCommand from './ManualCommand';
import CommandExecutor from './CommandExecutor';
import GPT3Request from './GPT3Request';
import HueController from './HueController';

async function main() {
    testLogger();
    logger.info('Starting the "Yui" application');
    logger.debug('Importing modules');

    // const commandRecognition = new CommandRecognition();
    const manualCommand = new ManualCommand();
    const commandExecutor = new CommandExecutor();
    const gpt3Request = new GPT3Request();
    const hueController = new HueController();

    logger.debug('Modules imported');

    logger.debug('Modules initialisation');

    await hueController.init().catch((error) => {
        logger.error(
            `Error during the initialisation of HueController: ${error}`,
        );
    });

    // const entities = await initEntitiesFromJson(hueController).catch((error: Error) => {
    //     logger.error(`Error during the initialisation of entities from JSON: ${error}`);
    // });

    const entities = await initEntitiesFromAPI(hueController).catch(
        (error: Error) => {
            logger.error(
                `Error during the initialisation of entities from API: ${error}`,
            );
        },
    );

    if (entities === undefined || entities.length === 0) {
        throw new Error('Entities are undefined');
    }

    const light = entities.find((entity) => entity instanceof Light) as Light;
    hueController.getLightState(light.id).then((state) => {
        console.log(state);
    });

    // await commandRecognition.init().catch((error) => {
    //     logger.error(`Error during the initialisation of commandRecognition: ${error}`);
    // });

    // await manualCommand.init().catch((error) => {
    //     logger.error(
    //         `Error during the initialisation of manualCommand: ${error}`,
    //     );
    // });

    await commandExecutor.init(entities).catch((error) => {
        logger.error(
            `Error during the initialisation of CommandExecutor: ${error}`,
        );
    });

    // await gpt3Request.init(commandExecutor, entities).catch((error) => {
    //     logger.error(
    //         `Error during the initialisation of gpt3Request: ${error}`,
    //     );
    // });
    logger.debug('Modules initialised');

    // try {
    //     await gpt3Request.command('Turn on the light in the chamber');
    // } catch (error) {
    //     logger.error(`Error during the execution of the command: ${error}`);
    // }

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
