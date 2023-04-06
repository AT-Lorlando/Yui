import { Configuration, OpenAIApi } from 'openai';
import { Entity } from './Entity';
import { logger } from './logger';
import env from './env';
import CommandExecutor from './CommandExecutor';
import * as fs from 'fs';

const DO_NOT_FETCH = true;

class gpt3Request {
    configuration: any;
    openai: any;
    exempleOrders: any;
    exempleReturns: any;
    testOrder: any;
    entities: any;
    commands: any;
    commandExecutor: any;

    constructor() {
        this.exempleOrders = [
            {
                requestID: 12,
                order: "turn off the chamber's lights turn on and the tv",
            },
            {
                requestID: 13,
                order: 'Yui, turn off everythings',
            },
            {
                requestID: 14,
                order: 'Please turn on the lights',
            },
            {
                requestID: 15,
                order: 'Turn off the chamber',
            },
        ];

        this.exempleReturns = [
            {
                requestID: '12',
                commands: ['shutdown(4)', 'turnon(6)'],
                confidence: 0.9,
            },
            {
                requestID: '13',
                commands: ['shutdown(4)', 'shutdown(5)', 'shutdown(6)'],
                confidence: 0.85,
            },
            {
                requestID: '14',
                commands: ['turnon(4)', 'turnon(5)'],
                confidence: 0.85,
            },
            {
                requestID: '15',
                commands: ['shutdown(4)'],
                confidence: 0.9,
            },
        ];

        // this.entities = [
        //     {
        //         id: 4,
        //         name: 'Light 1',
        //         room: 'chamber',
        //     },
        //     {
        //         id: 5,
        //         name: 'Light 2',
        //         room: 'living room',
        //     },
        //     {
        //         id: 6,
        //         name: 'TV',
        //         room: 'living room',
        //     },
        // ];

        this.commands = [
            'turnon(entityID: number)',
            'shutdown(entityID: number)',
            'lock(entityID: number)',
        ];
    }

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

        await this.testRequest().catch((err: any) => {
            logger.error(`GPT3Request init testRequest error.`);
            throw err;
        });
        await this.testCommandRequest().catch((err: any) => {
            logger.error(`GPT3Request init testCommandRequest error.`);
            throw err;
        });
    }

    private async fetch(text: string): Promise<string> {
        if (DO_NOT_FETCH) {
            return '{ "commands": ["shutdown(4)", "turnon(6)"], "confidence": 0.9 }';
        }
        const config35 = {
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: text }],
            temperature: 0.1,
            max_tokens: 100,
        };

        const response = await this.openai
            .createChatCompletion(config35)
            .catch((err: any) => {
                logger.error(err);
            });
        logger.debug('GPT3Request respond');
        logger.debug(response.data.choices[0].message.content);
        return response.data.choices[0].message.content;

        // const configDavinci = {
        //     model: "text-davinci-003",
        //     prompt: text,
        //     max_tokens: 500,
        //     temperature: 1,
        // }

        // const response = await this.openai.createCompletion(configDavinci);
        // logger.debug("GPT3Request respond");
        // logger.debug(text);
        // logger.debug(this.getJson(response.data.choices[0].text));
        // return this.getJson(response.data.choices[0].text);
    }

    private async fetchCommand(text: string): Promise<string> {
        // const config35 = {
        //     model: "gpt-3.5-turbo",
        //     messages: [
        //         {role: "system", content: `You are my assistant, your name is 'Yui'. I'll give you an order with a list of commands and entities, and you'll have to find the right command(s) to execute it. Be autonomous ! Answer only with JSON format as follow: {'message': '<Your message>', ...}.\nThe entities are grouped by room or by type, but can be specified if i use the term 'all the lights' or 'everythings', etc. Return your confidence between 0 and 1 each message in the JSON. Only answer with commands that exist in the following command list with entities that exist in the following entity list. If you have to execute multiple commands, return them in a list. Command must be used with none or one entity but NOT more. For exemple, you can not return 'command(all)' because all do not exist. Again, be autonomous. If the user don't specify the name of the entity, guess what entity he's talking about with the informations given.\n`},
        //         {role: "system", content: `Here is the list of entities: ${JSON.stringify(this.entities)}\nHere is the list of commands: ${JSON.stringify(this.commands)}`},
        //         {role: "system", content: `Here is an exemple of order: ${JSON.stringify(this.exempleOrder)}\nHere is an exemple of return: ${JSON.stringify(this.exempleReturn)}`},
        //         {role: "user", content: text}
        //     ],
        //     temperature: 0.5,
        //     max_tokens: 50,
        // }

        // const response = await this.openai.createChatCompletion(config35);
        // logger.debug("GPT3Request respond");
        // logger.debug(response.data.choices[0].message.content);
        // return response.data.choices[0].message.content;
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
            return '{ "commands": ["shutdown(4)", "turnon(6)"], "confidence": 0.9 }';
        }
        const response = await this.openai
            .createCompletion(configDavinci)
            .catch((err: any) => {
                logger.error(`Error during a request of gpt3Request: ${err}`);
                logger.error(text);
                logger.debug(err.response.status);
                logger.debug(err.response.data);
                logger.debug(err.message);
            });

        logger.info('GPT3Request respond : ' + text);
        logger.info(this.getJson(response.data.choices[0].text));
        return this.getJson(response.data.choices[0].text);
    }

    private getJson(text: string): string {
        if (text.match(/{([^}]+)}/) === null) {
            return `{\"message\": \"${text}\"}`;
        } else {
            return text.match(/{([^}]+)}/)![0];
        }
    }

    async request(text: string) {
        const reponse = await this.fetch(text).catch((error) => {
            logger.error(`Error during a request of gpt3Request: ${error}`);
            logger.debug(error.response.status);
            logger.debug(error.response.data);
            logger.debug(error.message);
        });
    }

    async testRequest() {
        await this.request(
            'This is a test, answer an json object like {"message": "ok"} if you can read this.',
        );
    }

    async testCommandRequest() {
        const testOrders = [
            'Hey, please turn off the living room',
            'Yui, turn off the lights',
            'Hey, please turn off the lights and start the tv',
        ];
        const testReturns = [
            {
                commands: ['shutdown(5)', 'shutdown(6)'],
            },
            {
                commands: ['shutdown(4)', 'shutdown(5)'],
            },
            {
                commands: ['shutdown(4)', 'shutdown(5)', 'turnon(6)'],
            },
        ];
        for (let i = 0; i < testOrders.length; i++) {
            const response = await this.fetchCommand(testOrders[i]).catch(
                (error) => {
                    logger.error(
                        `Fetch command error during testCommandRequest`,
                    );
                    throw error;
                },
            );
            const json = JSON.parse(response);
            const testCommands = testReturns[i].commands;
            json.commands.forEach((command: string) => {
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

    async command(text: string) {
        logger.info('Command request to GPT3Request : ' + text);
        const response = await this.fetchCommand(text);
        const json = JSON.parse(response);
        await json.commands.forEach(async (command: string) => {
            logger.info('Command execution from GPT3Request : ' + command);
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
