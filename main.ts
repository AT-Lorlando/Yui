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

    // await commandRecognition.init().catch((error) => {
    //     logger.error(`Error during the initialisation of commandRecognition: ${error}`);
    // });

    // await manualCommand.init().catch((error) => {
    //     logger.error(`Error during the initialisation of manualCommand: ${error}`);
    // });

    // await commandExecutor.init().catch((error) => {
    //     logger.error(`Error during the initialisation of CommandExecutor: ${error}`);
    // });

    // await gpt3Request.init().catch((error) => {
    //     logger.error(`Error during the initialisation of gpt3Request: ${error}`);
    // });
    logger.debug('Modules initialised');

    const entities = await initEntities().catch((error) => {
        logger.error(`Error during the initialisation of entities: ${error}`);
    });

    if (entities === undefined) {
        logger.error('Entities are undefined');
        return;
    }

    await testEntities(entities);

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
