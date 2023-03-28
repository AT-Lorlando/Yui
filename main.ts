import { logger } from './logger';
import { Entity, Light, TV, Speakers } from './Entity';
import dotenv from 'dotenv';
import { env } from './env';
dotenv.config();


// Importez vos modules ici
// import CommandRecognition from './CommandRecognition';
// import ManualCommand from './ManualCommand';
import CommandExecutor from './CommandExecutor';
// import GPT3Request from './GPT3Request';

async function main() {
    testLogger();
    logger.info('Starting the "Yui" application');


    logger.debug('Importing modules');
    // const commandRecognition = new CommandRecognition();
    // const manualCommand = new ManualCommand();
    const commandExecutor = new CommandExecutor();
    // const gpt3Request = new GPT3Request();
    logger.debug('Modules imported');

    logger.debug('Modules initialisation');
    try {
        // await commandRecognition.init();
    }
    catch (error) {
        logger.error(`Error during the initialisation of commandRecognition: ${error}`);
    }
    try {
        // await manualCommand.init();
    }
    catch (error) {
        logger.error(`Error during the initialisation of manualCommand: ${error}`);
    }
    try {
        await commandExecutor.init();
    }
    catch (error) {
        logger.error(`Error during the initialisation of CommandExecutor: ${error}`);
    }
    try {
        // await gpt3Request.init();
    }
    catch (error) {
        logger.error(`Error during the initialisation of gpt3Request: ${error}`);
    }
    logger.debug('Modules initialised');

    logger.info('Initialisation of the "Yui" application completed')

    await testEntities()
}

function testLogger() {
    logger.info('Information message');
    logger.verbose('Success message');
    logger.warn('Warning message');
    logger.error('Error message');
    logger.debug('Debug message');
}

async function testEntities() {
    const light = new Light('Lumière', 'Salon');
    const tv = new TV('TV', 'Salon');
    const speakers = new Speakers('Haut-parleurs', 'Salon');

    light.test();
    tv.test();
    speakers.test();
}

main()
    .then(() => {
        logger.info('Yui is ready to use');
    })
    .catch((error) => {
        logger.error(`Error during the initialisation of Yui: ${error.message}`);
});
