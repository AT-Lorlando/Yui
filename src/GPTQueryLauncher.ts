import {
    ChatCompletionResponseMessage,
    Configuration,
    OpenAIApi,
} from 'openai';
import Logger from './Logger';
import env from './env';
import CommandExecutor from './CommandExecutor';
import * as fs from 'fs';

// const DO_NOT_FETCH = true;
const DO_NOT_FETCH = false;
interface FunctionType {
    function: (...args: any[]) => any;
    arguments: string[];
}

class GPTQueryLauncher {
    configuration!: Configuration;
    openai!: OpenAIApi;
    commandExecutor!: CommandExecutor;

    async init(commandExecutor: CommandExecutor): Promise<void> {
        try {
            this.configuration = new Configuration({
                apiKey: env.OPENAI_API_KEY,
            });
            this.openai = new OpenAIApi(this.configuration);
            this.commandExecutor = commandExecutor;
        } catch (error) {
            Logger.error(`Error during the initialisation of GPTQL: ${error}`);
            throw new Error('Error during the initialisation of GPTQL');
        }
    }

    private async fetchGPT(config: any): Promise<any> {
        Logger.debug('GPT3Request fetchGPT');
        const response = await this.openai.createChatCompletion(config);
        Logger.info('GPTQL: GPT3Request respond');
        Logger.info(response.data.choices);
        return response.data.choices[0]
            .message as ChatCompletionResponseMessage;
    }

    private async fetchCommandFunctions(text: string): Promise<any> {
        const config35 = {
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: `Tu es Yui, un assistant vocal destiné à comprendre les différents ordres qui lui sont donnés. Tu es capable de contrôler des appareils électriques, des lumières, des volets, etc.
                    Pour ça, tu reçois un ordre humain, et tu dois trouver la ou les commandes et entités qui correspondent à cet ordre.\nSi la pièce n'est pas spécifié dans l'ordre, essaie de deviner (c'est souvent la chambre).\n
                    
                    Si tu obtiens un ordre à prévoir dans le temps, utilise la fonction addTimedEvent(timestamp, function, function_parameters) pour le prévoir, mais n'oublies pas de récupérer les arguments avant ! Par exemple, pour eteindre toutes les lumieres, d'abord récupère les ID avec getEntities, recupere la datepuis: addTimedEvent(10000, {function: lightsTurnOff, parameters: [<result>]}).\n
                    Outre les ordres, tu peux également répondre comme un humain aux questions qui te sont posées.\nS`,
                },
                {
                    role: 'user',
                    content: "Voici l'ordre reçu :" + text,
                },
            ],
            functions: [
                {
                    name: 'getEntities',
                    description:
                        'Return the list of entities, containing their ID, name, type and room',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: [],
                    },
                },

                {
                    name: 'addTimedEvent',
                    description: 'Add a timed event',
                    parameters: {
                        type: 'object',
                        properties: {
                            timestamp: {
                                type: 'number',
                                description:
                                    'A timestamp in milliseconds that will be added to the current timestamp to set the time of the event',
                            },
                            function_call: {
                                type: 'object',
                                description:
                                    'An object containing the name of the function to call and its parameters',
                                properties: {
                                    function: {
                                        type: 'string',
                                        description:
                                            'The name of the function to call',
                                    },
                                    parameters: {
                                        type: 'object',
                                        description:
                                            'An object containing the parameters of the function',
                                    },
                                },
                            },
                        },
                        required: [
                            'timestamp',
                            'function',
                            'function_parameters',
                        ],
                    },
                },
                {
                    name: 'lightsTurnOn',
                    description: 'Turns on a light',
                    parameters: {
                        type: 'object',
                        properties: {
                            lightsID: {
                                type: 'array',
                                description:
                                    "An array of light's ID to turn on",
                                items: {
                                    type: 'number',
                                },
                            },
                        },
                        required: ['lightsID'],
                    },
                },
                {
                    name: 'lightsTurnOff',
                    description: 'Turns off a light',
                    parameters: {
                        type: 'object',
                        properties: {
                            lightsID: {
                                type: 'array',
                                description:
                                    "An array of light's ID to turn off",
                                items: {
                                    type: 'number',
                                },
                            },
                        },
                        required: ['lightsID'],
                    },
                },
                {
                    name: 'lightsSetLuminosity',
                    description: 'Sets the luminosity of a light',
                    parameters: {
                        type: 'object',
                        properties: {
                            lightsID: {
                                type: 'array',
                                description:
                                    "An array of light's ID to turn off",
                                items: {
                                    type: 'number',
                                },
                            },
                            luminosity: {
                                type: 'number',
                                description:
                                    'The luminosity to set, between 0 and 100',
                            },
                        },
                        required: ['lightsID', 'luminosity'],
                    },
                },
                {
                    name: 'lightsSetColor',
                    description: 'Sets the color of a lights array',
                    parameters: {
                        type: 'object',
                        properties: {
                            lightsID: {
                                type: 'array',
                                description:
                                    "An array of light's ID to set the color of",
                                items: {
                                    type: 'number',
                                },
                            },
                            color: {
                                type: 'string',
                                description:
                                    'The color to set, in hexadecimal format',
                            },
                        },
                        required: ['lightsID', 'color'],
                    },
                },
                {
                    name: 'speakersPlay',
                    description: 'Plays a sound on a speaker array',
                    parameters: {
                        type: 'object',
                        properties: {
                            speakersID: {
                                type: 'array',
                                items: {
                                    type: 'number',
                                },
                                description:
                                    "An array of speaker's ID to play the sound on",
                            },
                            url: {
                                type: 'string',
                                description: 'The url of the sound to play',
                            },
                        },
                        required: ['speakersID', 'url'],
                    },
                },
                {
                    name: 'speakersStop',
                    description:
                        'Stops the sound currently playing on the speakers',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: [],
                    },
                },
                {
                    name: 'speakersRaiseVolume',
                    description: 'Raises the volume of the speakers',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: [],
                    },
                },
                {
                    name: 'speakersLowerVolume',
                    description: 'Lowers the volume of the speakers',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: [],
                    },
                },
                {
                    name: 'doorsUnlock',
                    description: 'Unlocks doors',
                    parameters: {
                        type: 'object',
                        properties: {
                            doorsID: {
                                type: 'array',
                                items: {
                                    type: 'number',
                                },
                                description: "An array of door's ID to unlock",
                            },
                        },
                        required: ['doorsID'],
                    },
                },
                {
                    name: 'doorsLock',
                    description: 'Locks doors',
                    parameters: {
                        type: 'object',
                        properties: {
                            doorsID: {
                                type: 'array',
                                items: {
                                    type: 'number',
                                },
                                description: "An array of door's ID to lock",
                            },
                        },
                        required: ['doorsID'],
                    },
                },
            ],
            function_call: 'auto',
            temperature: 0.2,
            max_tokens: 200,
        };

        if (DO_NOT_FETCH) {
            return { commands: ['turnoff(4)', 'turnon(5)'], confidence: 0.9 };
        }

        const message = await this.fetchGPT(config35).catch((err: any) => {
            Logger.error(
                `GPTQL: Error during a request of GPTQueryLauncher: ${err}` +
                    ` Order : ${text}`,
            );
            console.log(err.response);
            return;
            // throw err;
        });

        try {
            if (message.function_call) {
                const analyse = await this.analyseFunction(config35, message);
                Logger.info(
                    'GPTQL: GPT3Request respond to ' + text.replace('\n', ''),
                );
                Logger.info(analyse.content);
            } else {
                Logger.info(
                    'GPTQL: GPT3Request respond to ' + text.replace('\n', ''),
                );
                Logger.info(message.content);
            }
        } catch (err: any) {
            Logger.error('GPTQL: Error during an analyse of GPTQueryLauncher');
            console.log(err);
        }
    }

    async analyseFunction(config: any, message: any): Promise<any> {
        Logger.debug('GPTQL: analyseFunction');
        const availableFunctions = {
            getEntities: {
                function: this.commandExecutor.getEntities,
                arguments: [],
            },
            getTimestamp: {
                function: this.commandExecutor.getTimestamp,
                arguments: [],
            },
            addTimedEvent: {
                function: this.commandExecutor.addTimedEvent,
                arguments: ['timestamp', 'function', 'parameters'],
            },
            lightsTurnOn: {
                function: this.commandExecutor.lightsTurnOn,
                arguments: ['lightsID'],
            },
            lightsTurnOff: {
                function: this.commandExecutor.lightsTurnOff,
                arguments: ['lightsID'],
            },
            lightsSetLuminosity: {
                function: this.commandExecutor.lightsSetLuminosity,
                arguments: ['lightsID', 'luminosity'],
            },
            lightsSetColor: {
                function: this.commandExecutor.lightsSetColor,
                arguments: ['lightsID', 'color'],
            },
            speakersPlay: {
                function: this.commandExecutor.speakersPlay,
                arguments: ['speakersID', 'url'],
            },
            speakersStop: {
                function: this.commandExecutor.speakersStop,
                arguments: [],
            },
            speakersRaiseVolume: {
                function: this.commandExecutor.speakersRaiseVolume,
                arguments: [],
            },
            speakersLowerVolume: {
                function: this.commandExecutor.speakersLowerVolume,
                arguments: [],
            },
            doorsUnlock: {
                function: this.commandExecutor.doorsUnlock,
                arguments: ['doorsID'],
            },
            doorsLock: {
                function: this.commandExecutor.doorsLock,
                arguments: ['doorsID'],
            },
        } as {
            [key: string]: FunctionType;
        };
        const functionName = message.function_call.name as string;
        const responseArguments = JSON.parse(message.function_call.arguments);
        const argNames = availableFunctions[functionName].arguments;
        Logger.debug(
            `GPTQL: analyseFunction: functionName : ${functionName} | responseArguments : ${responseArguments} | argNames : ${argNames}`,
        );
        const functionCall = availableFunctions[functionName].function;
        const functionArguments = argNames.map(
            (argName) => responseArguments[argName],
        );

        try {
            Logger.debug(
                `Calling function ${functionName} with arguments ${functionArguments}`,
            );
            // If it's a timed event, we need to put a pointer to the function
            if (functionName === 'addTimedEvent') {
                const callbackName = functionArguments[1].function;
                const callbackArguments = functionArguments[1].arguments;
                functionArguments[1] =
                    availableFunctions[callbackName].function;
                functionArguments.push(callbackArguments);
            }
            const functionReturn = await functionCall.apply(
                this.commandExecutor,
                functionArguments,
            );
            const return_message = {
                role: 'function',
                name: functionName,
                content: functionReturn
                    ? JSON.stringify(functionReturn)
                    : 'null',
            };
            Logger.debug(
                `GPT need function ${functionName} and returned ${JSON.stringify(
                    functionReturn,
                )}`,
            );
            config.messages.push(message);
            config.messages.push(return_message);
        } catch (err) {
            Logger.error(
                `Error calling function ${functionName} with arguments ${functionArguments}`,
            );
            console.log(err);
            return;
        }

        const responseMessage = await this.fetchGPT(config).catch(
            (err: any) => {
                Logger.error(
                    `Error during a request of GPTQueryLauncher: ${err}`,
                );
                Logger.error(err.response.data);
            },
        );
        if (responseMessage.function_call) {
            return this.analyseFunction(config, responseMessage);
        } else {
            return responseMessage;
        }
    }

    async evalCommandFromOrder(text: string) {
        Logger.info(
            'GPTQL: Fetching a command from order : ' + text.replace('\n', ''),
        );
        await this.fetchCommandFunctions(text);
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

export default GPTQueryLauncher;
