import LlmController from '../Controller/LlmController';
import Story from '../Object/Story';
import {
    Command,
    Order,
    LlmResponse,
    StoryMessage,
    LlmRouterResponse,
    LlmRouterQuery,
} from '../types/types';
import Logger from '../Logger';
import CommandExecutor from './CommandExecutor';
import Entity from '../Entity/Entity';
import { Light } from '../Entity/Light';
import fs from 'fs';
import PlaywrightController from '../Controller/PlaywrightController';

export default class Orchestrator {
    public entities: Entity[];
    constructor(
        private readonly CommandExecutor: CommandExecutor,
        private readonly llmController = new LlmController(),
        private readonly playwrightController = new PlaywrightController(),
    ) {
        this.entities = CommandExecutor.entities;
    }

    fillPlaceholders(systemPrompt: string): string {
        const path = './assets/prompts/docs/';
        const placeholders: { [key: string]: string } = {
            '<entities_placeholder>': this.entities
                .map((entity) => entity.__str__())
                .join('\n'),
            '<GLOBAL_COMMANDS_PLACEHOLDER>': fs.readFileSync(
                path + 'Global.json',
                'utf8',
            ),
            '<LIGHTS_COMMANDS_PLACEHOLDER>': fs.readFileSync(
                path + 'Light.json',
                'utf8',
            ),
            '<LIGHTS_ENTITIES_PLACEHOLDER>': this.entities
                .filter((entity) => entity instanceof Light)
                .map((entity) => entity.__str__())
                .join('\n'),
            '<BROWSER_COMMANDS_PLACEHOLDER>': fs.readFileSync(
                path + 'Browser.json',
                'utf8',
            ),
        };

        for (const placeholder in placeholders) {
            systemPrompt = systemPrompt.replace(
                placeholder,
                placeholders[placeholder],
            );
        }
        return systemPrompt;
    }

    async getRouterQueriesFromOrder(order: Order): Promise<void> {
        const queries = await this.getQueries(order);

        for (const query of queries) {
            try {
                const story = await this.aNewStory(query);
                Logger.debug(`Story ${story.id} created`);
            } catch (error) {
                Logger.error(`Error while creating a new story:` + error);
            }
        }
    }

    async aNewStory(query: LlmRouterQuery): Promise<Story> {
        const category = query.category;
        const order = query.order;
        let systemPrompt = await this.llmController.getLlmSystemPrompt(
            category,
        );
        systemPrompt = this.fillPlaceholders(systemPrompt);
        const story = new Story(category, systemPrompt, order);
        // const maxTurns = 10 if (category === 'router') else 5
        const maxTurns = category === 'browser' ? 10 : 5;
        let shouldBreak = false;
        for (let turn = 0; turn <= maxTurns; turn++) {
            if (shouldBreak) {
                break;
            }
            const response = (await this.llmController.sendToLlm(
                category,
                story.content,
            )) as LlmResponse;
            story.addAssistantStep(response);

            for (const command of response.commands) {
                let result = 'Result for each commands:';

                const { functionName, parameters, paramString } =
                    this.getFunctionNameAndParameters(command);

                if (command.name == 'AskToUser') {
                    result += await this.askToUser(command);
                } else if (command.name == 'SayToUser') {
                    if (!parameters || !parameters.text) {
                        Logger.error('No text provided');
                        throw new Error('No text provided');
                    }
                    Logger.debug(`Assistant says: ${parameters.text}`);
                    result += `\n${functionName}: Said successfully`;
                    shouldBreak = true;
                } else if (command.entities) {
                    result += await this.evalEntitiesCommand(command);
                } else {
                    const codeToEval = `this.playwrightController.${functionName}(${paramString})`;
                    Logger.debug(`Executing command ${codeToEval}`);
                    try {
                        const evaluation = await eval(codeToEval);
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
                        Logger.error(
                            'Error while executing the command: ' + error,
                        );
                    }
                }
                story.addStep('system', result);
            }
        }

        story.Save();
        return story;
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

    async evalEntitiesCommand(command: Command): Promise<string> {
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
                    Logger.error('Error while executing the command: ' + error);
                }
            }
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
        result += `\nUser response for ${functionName}: Toulouse`;
        return result;
    }

    async getQueries(order: Order): Promise<LlmRouterQuery[]> {
        const LLM = 'router';
        const story = [
            {
                role: 'user',
                content: `Order: ${order.content}, Timestamp: ${order.timestamp}`,
            } as StoryMessage,
        ];
        const result = (await this.llmController.sendToLlm(
            LLM,
            story,
        )) as LlmRouterResponse;

        const queries = result.queries;
        Logger.debug(
            `Order ${order.content} resulted in ${queries.length} queries`,
        );
        for (const query of queries) {
            Logger.debug(`Query: ${query.category} ${query.order}`);
        }
        return result.queries;
    }
}
