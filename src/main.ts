import { logger, testLogger } from './logger';
import { initEntities, testEntities, Entity } from './Entity';

// Importez vos modules ici
// import CommandRecognition from './CommandRecognition';
// import ManualCommand from './ManualCommand';
import CommandExecutor from './CommandExecutor';
import GPT3Request from './GPT3Request';

async function main() {
    testLogger();
    logger.info('Starting the "Yui" application');
    logger.debug('Importing modules');

    // const commandRecognition = new CommandRecognition();
    // const manualCommand = new ManualCommand();
    const commandExecutor = new CommandExecutor();
    const gpt3Request = new GPT3Request();

    logger.debug('Modules imported');

    logger.debug('Modules initialisation');
    const entities = await initEntities().catch((error: Error) => {
        logger.error(`Error during the initialisation of entities: ${error}`);
    });

    if (entities === undefined) {
        logger.error('Entities are undefined');
        return;
    }

    await testEntities(entities);
    // await commandRecognition.init().catch((error) => {
    //     logger.error(`Error during the initialisation of commandRecognition: ${error}`);
    // });

    // await manualCommand.init().catch((error) => {
    //     logger.error(`Error during the initialisation of manualCommand: ${error}`);
    // });

    await commandExecutor.init(entities).catch((error) => {
        logger.error(
            `Error during the initialisation of CommandExecutor: ${error}`,
        );
    });

    await gpt3Request.init(commandExecutor, entities).catch((error) => {
        logger.error(
            `Error during the initialisation of gpt3Request: ${error}`,
        );
    });
    logger.debug('Modules initialised');

    try {
        await gpt3Request.command('Turn on the light in the chamber');
    } catch (error) {
        logger.error(`Error during the execution of the command: ${error}`);
    }

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
