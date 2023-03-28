import { logger } from './logger';
import { Entity, Light, TV, Speakers } from './Entity';

// Importez vos modules ici
// import CommandRecognition from './CommandRecognition';
// import ManualCommand from './ManualCommand';
import CommandExecutor from './CommandExecutor';
// import GPT3Request from './GPT3Request';

async function main() {
    logger.info('Starting the "Yui" application');
    logger.info('Information message');
    logger.verbose('Success message');
    logger.warn('Warning message');
    logger.error('Error message');
    logger.debug('Debug message');

    // Initialisez vos modules ici
    // const commandRecognition = new CommandRecognition();
    // const manualCommand = new ManualCommand();
    const commandExecutor = new CommandExecutor();
    // const gpt3Request = new GPT3Request();

    logger.info('Initialisation of the "Yui" application completed')

    const light = new Light('Lumière', 'Salon');
    const speakers = new Speakers('Haut-parleurs', 'Salon');

    commandExecutor.startup(light);
    commandExecutor.startup(speakers);
}

main()
    .then(() => {
        logger.info('Yui is ready to use');
    })
    .catch((error) => {
        logger.error(`Error during the initialisation of Yui: ${error.message}`);
});
