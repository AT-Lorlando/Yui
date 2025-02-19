import Entity from '../Entity/Entity';
import Logger from '../Logger';
import SpotifyController from '../Controller/SpotifyController';
import PlaywrightController from '../Controller/PlaywrightController';
import { Command } from '../types/types';

export default class CommandExecutor {
    playwrightControllerMethods: string[];
    entitiesMethods: string[];
    globalMethods: string[];
    constructor(
        private spotifyController: SpotifyController,
        private playwrightController: PlaywrightController,
        public entities: Entity[],
    ) {
        this.globalMethods = ['AskToUser', 'SayToUser'];
        this.entitiesMethods = [];
        this.playwrightControllerMethods = Object.getOwnPropertyNames(
            PlaywrightController.prototype,
        );
        for (const entity of entities) {
            const entityMethods = Object.getOwnPropertyNames(
                entity.constructor.prototype,
            );
            for (const method of entityMethods) {
                if (!this.entitiesMethods.includes(method)) {
                    this.entitiesMethods.push(method);
                }
            }
        }
        Logger.debug(this.globalMethods);
        Logger.debug(this.entitiesMethods);
        Logger.debug(this.playwrightControllerMethods);
    }

    private getEntity(entityID: number): Entity {
        const entity = this.entities.find((entity) => entity.id === entityID);
        if (entity === undefined) {
            throw new Error(`Entity with id ${entityID} not found`);
        }
        return entity;
    }

    async spotifyAuth(code: string): Promise<void> {
        if (this.spotifyController === undefined) {
            throw new Error('SpotifyController is undefined');
        }
        this.spotifyController
            .exchangeAuthorizationCode(code)
            .then(({ accessToken, refreshToken }) => {
                if (this.spotifyController === undefined) {
                    throw new Error('SpotifyController is undefined');
                }
                this.spotifyController.saveRefreshToken(refreshToken);
                this.spotifyController.setAccessToken(accessToken);
            });
    }

    getFunctionNameAndParameters(command: Command): {
        functionName: string;
        parameters: Record<string, unknown> | undefined;
        paramString: string;
    } {
        const functionName = command.name;
        const parameters = command.parameters;
        let paramString = '';
        if (parameters) {
            paramString = Object.keys(parameters)
                .map((key) => {
                    if (typeof parameters[key] === 'string') {
                        return `"${parameters[key]}"`;
                    } else {
                        return `${parameters[key]}`;
                    }
                })
                .join(',');
        }
        return { functionName, parameters, paramString };
    }

    async entitiesCommand(command: Command): Promise<string> {
        const { functionName, paramString } =
            this.getFunctionNameAndParameters(command);
        let result = '';
        if (command.entities) {
            const entitiesId = command.entities;
            const entities = this.entities.filter((entity) =>
                entitiesId.includes(entity.id),
            );
            if (!entities) {
                Logger.error(
                    `Entity with id ${entitiesId} not found in the entities list`,
                );
                return 'Error';
            }
            for (const entity of entities) {
                const codeToEval = `entity.${functionName}(${paramString})`;
                Logger.debug(
                    `Executing command ${codeToEval} on entity ${entity.name}`,
                );
                try {
                    const evaluation = await eval(codeToEval);
                    if (evaluation.status === 'error') {
                        Logger.error(
                            `Error while executing the command: ${evaluation.message}`,
                        );
                        result += `\n${entity.name} - ${functionName}: ${evaluation.message}`;
                    } else {
                        result += `\n${entity.name} - ${functionName}: ${evaluation.message}`;
                    }
                } catch (error) {
                    throw new Error(
                        `Error while executing the command: ${codeToEval} on entity ${entity.id}` +
                            error,
                    );
                }
            }
        }
        return result;
    }

    async playwrightCommand(command: Command): Promise<string> {
        const { functionName, paramString } =
            this.getFunctionNameAndParameters(command);
        let result = '';
        const codeToEval = `${functionName}(${paramString})`;
        Logger.debug(`Executing command ${codeToEval}`);
        try {
            const evaluation = await this.playwrightController.evalCode(
                codeToEval,
            );
            if (evaluation.status === 'error') {
                Logger.error(
                    `Error while executing the command: ${evaluation.message}`,
                );
                result += `\n$${functionName}: ${evaluation.message}`;
            } else {
                if (evaluation.content) {
                    result += `\n$${functionName}: ${evaluation.message}: \n \`\`\`${evaluation.content}\`\`\``;
                } else {
                    result += `\n$${functionName}: ${evaluation.message}`;
                }
            }
        } catch (error) {
            throw new Error(
                `Error while executing the command on playwright: ${codeToEval}` +
                    error,
            );
        }
        return result;
    }

    async askToUser(command: Command): Promise<string> {
        const { functionName, parameters } =
            this.getFunctionNameAndParameters(command);
        let result = '';

        if (!parameters || !parameters.question) {
            Logger.error('No question provided');
            throw new Error('No question provided');
        }
        Logger.debug(`Assistant asks: ${parameters.question}`);
        // Mocking the user response
        result += `\nUser response for ${functionName}: Toulouse`;
        return result;
    }

    async sayToUser(command: Command): Promise<string> {
        const { functionName, parameters } =
            this.getFunctionNameAndParameters(command);
        if (!parameters || !parameters.text) {
            Logger.error('No text provided');
            throw new Error('No text provided');
        }
        Logger.debug(`Assistant says: ${parameters.text}`);
        return `\n${functionName}: Said successfully`;
    }

    getEntities(): { name: string; id: number; room: string; type: string }[] {
        return this.entities.map((entity) => {
            const { name, id, room } = entity;
            const type = entity.constructor.name;
            return { name, id, room, type };
        });
    }

    test(entityID: number): void {
        try {
            const entity = this.getEntity(entityID);
            entity.test();
        } catch (error: any) {
            Logger.error(error.message);
            throw error;
        }
    }

    public async evalCommand(
        command: Command,
    ): Promise<{ result: string; shouldBreak: boolean }> {
        let result = '';
        let shouldBreak = false;

        try {
            if (this.entitiesMethods.includes(command.name)) {
                result += await this.entitiesCommand(command);
            } else if (
                this.playwrightControllerMethods.includes(command.name)
            ) {
                result += await this.playwrightCommand(command);
            } else if (this.globalMethods.includes(command.name)) {
                if (command.name === 'AskToUser') {
                    result += await this.askToUser(command);
                } else if (command.name === 'SayToUser') {
                    result += await this.sayToUser(command);
                    shouldBreak = true;
                }
            } else {
                throw new Error(`Command ${command.name} not found`);
            }
        } catch (error) {
            result += `\nError while executing the command ${command.name}: ${error}`;
            Logger.error(
                `Error while executing the command ${command.name}: ${error}`,
            );
        }

        return { result, shouldBreak };
    }
}
