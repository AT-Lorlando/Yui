import { Configuration, OpenAIApi } from 'openai';
import { Entity } from './Entity';
import { logger } from './logger';
import env from './env';
import CommandExecutor from './CommandExecutor';
import * as fs from 'fs';

const DO_NOT_FETCH = false;

class gpt3Request {
    configuration: any;
    openai: any;
    testOrder: any;
    entities: any;
    commandExecutor: any;

    exempleOrders = [
        {
            requestID: 12,
            order: 'Eteint la lumière',
        },
        {
            requestID: 13,
            order: 'Yui, éteint tout',
        },
        {
            requestID: 14,
            order: "Allume la lumière s'il te plait",
        },
        {
            requestID: 15,
            order: 'Baisse la lumière',
        },
        {
            requestID: 16,
            order: 'Met la lumière de la chambre à 50%',
        },
    ];
    exempleReturns = [
        {
            requestID: '12',
            commands: ['turnoff(4)', 'turnoff(12)'],
            confidence: 0.9,
        },
        {
            requestID: '13',
            commands: ['turnoff(4)', 'turnoff(5)', 'turnoff(12)'],
            confidence: 0.85,
        },
        {
            requestID: '14',
            commands: ['turnon(4)', 'turnon(12)'],
            confidence: 0.85,
        },
        {
            requestID: '15',
            commands: ['lower_luminosity(4)', 'lower_luminosity(12)'],
            confidence: 0.9,
        },
        {
            requestID: '16',
            commands: ['set_luminosity(4, 50)', 'set_luminosity(12, 50)'],
        },
    ];
    commands = [
        'turnoff(entityID: number) // Allume une entité',
        'turnon(entityID: number) // Eteint une entité',
        "set_luminosity(entityID: number, luminosity: number) // Change la luminosité d'une entité a une valeur entre 0 et 100",
        "set_color(entityID: number, color: string) // Change la couleur d'une entité",
        "lower_luminosity(entityID: number) // Diminue la luminosité d'une entité de 10%",
        "raise_luminosity(entityID: number) // Augmente la luminosité d'une entité de 10%",
    ];
    globalCommands = ['turnoff', 'turnon', 'test'];

    async init(
        commandExecutor: CommandExecutor,
        entities: any[],
    ): Promise<void> {
        this.configuration = new Configuration({
            apiKey: env.OPENAI_API_KEY,
        });
        this.openai = new OpenAIApi(this.configuration);
        this.commandExecutor = commandExecutor;
        this.entities = entities.map((entity: Entity) => {
            return {
                id: entity.id,
                name: entity.name,
                room: entity.room,
            };
        });

        await this.testCommandRequest().catch((err: any) => {
            logger.error(`GPT3Request init testCommandRequest error.`);
            throw err;
        });
    }

    private async fetchCommandDavinci(text: string): Promise<string> {
        let content = `You are my assistant, your name is 'Yui'. I'll give you a list of commands and entities, with an order, and you'll have to find the right command(s) and entities that correspond to the order. Be autonomous ! Answer only with JSON format as follow: {\"message\": \"<Your message>\", ...}.
        Here is the list of entities: ${JSON.stringify(this.entities)}
        Here is the list of commands: ${JSON.stringify(this.commands)}
        The entities can be grouped by room or by type, and it can be specified if i use the term 'all the lights' or 'everythings' for exemple. If I said 'Turn off the living room', turn off every entities that are in the room. Return your confidence between 0 and 1 each message in the JSON. 
        Only answer with commands that exist in the previous command list with entities that exist in the privious entity list. If you have to execute multiple commands, return them in a list. Command must be used with none or one entity but NOT more. For exemple, you can not return 'command(all)' because all do not exist. Again, be autonomous. If the user don't specify the name of the entity, guess what entity he's talking about with the informations given.\n`;

        this.exempleOrders.forEach((order: any, index: number) => {
            content += `Here is an exemple of order ${JSON.stringify(
                order,
            )} that must return ${JSON.stringify(
                this.exempleReturns[index],
            )}\n`;
        });
        content += `Here is the order: ${JSON.stringify(text)}\n`;

        const configDavinci = {
            model: 'text-davinci-003',
            prompt: content,
            max_tokens: 500,
            temperature: 0.8,
        };

        logger.debug(content);
        if (DO_NOT_FETCH) {
            return '{ "commands": ["turnoff(4)", "turnon(6)"], "confidence": 0.9 }';
        }
        const response = await this.openai
            .createCompletion(configDavinci)
            .catch((err: any) => {
                logger.error(
                    `Error during a request of gpt3Request: ${err}` +
                        ` Order : ${text}`,
                );
                logger.error(err.response.statusText);
                throw err;
            });

        logger.info('GPT3Request respond : ' + text);
        logger.info(this.getJsonFromResponse(response.data.choices[0].text));
        return this.getJsonFromResponse(response.data.choices[0].text);
    }

    private async fetchCommandChat(text: string): Promise<any> {
        const config35 = {
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: `Tu es CHATGPT, un modele de langage entrainé par OpenAI et répondant aux demandes en JSON. Tu aides un assistant vocal, nommé Yui, à comprendre les différents ordres qui lui sont donnés. Cet assistant est capable de contrôler des appareils électriques, des lumières, des volets, etc.\nIl est capable d'utiliser les commandes suivantes: ${JSON.stringify(
                        this.commands,
                    )}.\nCes commandes peuvent être éxécutées sur des entités, qui sont des appareils, des lumières, des volets, etc. Ces entités sont les suivantes: ${JSON.stringify(
                        this.entities,
                    )}.\nPour éxécuter ces commandes, Yui reçoit un ordre humain, et tu dois trouver la ou les commandes et entités qui correspondent à cet ordre. Attention, Yui ne comprend pas le langage comme toi, Yui ne sait lire qu'un format JSON. Pour cela, tu dois répondre au format JSON, comme suit: {\"commands\": \"<...>\"} Ne met pas de \" dans ton JSON, sinon Yui aura une erreur. Yui lira ce JSON et éxécutera les commandes que tu lui aura donné. N'explicite pas ta démarche car Yui ne comprendra pas.\nSi la pièce n'est pas spécifié dans l'ordre, essaie de deviner (c'est souvent la chambre).`,
                },
                {
                    role: 'system',
                    content: `Voici un exemple d'ordre que Yui reçoit: ${JSON.stringify(
                        this.exempleOrders[0],
                    )} et tu dois répondre: ${JSON.stringify(
                        this.exempleReturns[0],
                    )}`,
                },
                {
                    role: 'system',
                    content: `Voici un autre exemple d'ordre que Yui reçoit: ${JSON.stringify(
                        this.exempleOrders[1],
                    )} et tu dois répondre: ${JSON.stringify(
                        this.exempleReturns[1],
                    )}`,
                },
                {
                    role: 'system',
                    content: `Voici un autre exemple d'ordre que Yui reçoit: ${JSON.stringify(
                        this.exempleOrders[2],
                    )} et tu dois répondre: ${JSON.stringify(
                        this.exempleReturns[2],
                    )}`,
                },
                {
                    role: 'system',
                    content: `Voici un autre exemple d'ordre que Yui reçoit: ${JSON.stringify(
                        this.exempleOrders[3],
                    )} et tu dois répondre: ${JSON.stringify(
                        this.exempleReturns[2],
                    )}`,
                },
                {
                    role: 'system',
                    content: `Voici un autre exemple d'ordre que Yui reçoit: ${JSON.stringify(
                        this.exempleOrders[4],
                    )} et tu dois répondre: ${JSON.stringify(
                        this.exempleReturns[2],
                    )}`,
                },
                {
                    role: 'system',
                    content: `Les autres messages d'utilisateurs seront les ordres que reçoit Yui, retourne les commandes et entités qui correspondent à ces ordres. A partir de maintenant, répond UNIQUEMENT en JSON, et attention à ne pas écrire de <\"> dans ton JSON.`,
                },
                {
                    role: 'user',
                    content:
                        "Voici l'ordre reçu :" +
                        text +
                        `\n Que doit faire Yui ?`,
                },
            ],
            temperature: 0.2,
            max_tokens: 100,
        };

        if (DO_NOT_FETCH) {
            return '{ "commands": ["turnoff(4)", "turnon(6)"], "confidence": 0.9 }';
        }

        const response = await this.openai
            .createChatCompletion(config35)
            .catch((err: any) => {
                logger.error(
                    `Error during a request of gpt3Request: ${err}` +
                        ` Order : ${text}`,
                );
                logger.error(err.response.statusText);
                throw err;
            });
        logger.info('GPT3Request respond to ' + text);
        logger.info(response.data.choices[0].message.content);

        const jsonInResponse = this.getJsonFromResponse(
            response.data.choices[0].message.content,
        );

        return JSON.parse(jsonInResponse);
    }

    private getJsonFromResponse(text: string): string {
        if (text.match(/{([^}]+)}/) === null) {
            return `{\"message\": \"${text}\"}`;
        } else {
            return text.match(/{([^}]+)}/)![0];
        }
    }

    async testCommandRequest() {
        const testOrders = [
            "Hey, s'il te plait, éteins les lumières",
            'Yui, éteins la chambre et le rez de chaussée',
            'Met la luminosité à 10%',
        ];
        const testReturns = [
            {
                commands: ['turnoff(4)', 'turnoff(12)'],
            },
            {
                commands: ['turnoff(4)', 'turnoff(12)', 'turnoff(5)'],
            },
            {
                commands: ['set_luminosity(4,10)', 'set_luminosity(12,10)'],
            },
        ];
        for (let i = 0; i < testOrders.length; i++) {
            const response = await this.fetchCommandChat(testOrders[i]).catch(
                (error) => {
                    logger.error(
                        `Fetch command error during testCommandRequest`,
                    );
                    throw error;
                },
            );

            const testCommands = testReturns[i].commands;
            response.commands.forEach((command: string) => {
                if (testCommands.includes(command)) {
                    logger.debug(command + ' ✅');
                    testCommands.splice(testCommands.indexOf(command), 1);
                } else {
                    logger.debug(command + ' ❌');
                }
            });
            if (testCommands.length === 0) {
                logger.debug('Commands succeed ✅');
            } else {
                logger.debug('Command needed :');
                testCommands.forEach((command: string) => {
                    logger.debug(command + ' ❌');
                });
            }
        }
    }

    async getCommandFromOrder(text: string) {
        logger.info('Get command with request to GPT3Request : ' + text);
        const response = await this.fetchCommandChat(text);
        await response.commands.forEach(async (command: string) => {
            logger.info('Command execution from GPT3Request : ' + command);
            if (command) {
            }
            try {
                eval(`this.commandExecutor.${command}`);
            } catch (error: any) {
                logger.error(
                    `Error the evaluation of ${command} : ${error.message}`,
                );
                this.saveCommand(text, command, true);
                return;
            } finally {
                this.saveCommand(text, command);
            }
        });
    }

    async saveCommand(order: string, result: string, error = false) {
        const data = `${order} => ${result}\n`;
        fs.appendFile(
            `commands/${error ? 'error' : 'success'}.txt`,
            data,
            (err) => {
                if (err) throw err;
            },
        );
    }
}

export default gpt3Request;
