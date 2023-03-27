import logger from './logger';

// Importez vos modules ici
// import CommandRecognition from './CommandRecognition';
// import ManualCommand from './ManualCommand';
// import CommandExecutor from './CommandExecutor';
// import GPT3Request from './GPT3Request';

async function main() {
  logger.info('Démarrage de l\'application "Yui"');

  // Initialisez vos modules ici
  // const commandRecognition = new CommandRecognition();
  // const manualCommand = new ManualCommand();
  // const commandExecutor = new CommandExecutor();
  // const gpt3Request = new GPT3Request();

  logger.info('Initialisation des modules terminée');
}

main()
  .then(() => {
    logger.info('L\'application "Yui" est en cours d\'exécution');
  })
  .catch((error) => {
    logger.error(`Erreur lors de l'exécution de l'application : ${error.message}`);
  });
