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

export default class Orchestrator {
    public entities: Entity[];
    constructor(
        private readonly CommandExecutor: CommandExecutor,
        private readonly llmController = new LlmController(),
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
        let shouldBreak = false;

        for (let turn = 0; turn <= 5; turn++) {
            if (shouldBreak) {
                break;
            }

            const response = (await this.llmController.sendToLlm(
                category,
                story.content,
            )) as LlmResponse;
            story.addAssistantStep(response);
            for (let command of response.commands) {
                let result = 'Result for each commands:';
                command = command as Command;

                if (command.name === 'Say') {
                    shouldBreak = true;
                    if (!command.parameters) {
                        Logger.error(
                            'Say command must have a parameters field',
                        );
                        continue;
                    }
                    Logger.debug(
                        `Assistant says: ${command.parameters.text} in turn ${turn}`,
                    );
                    break;
                }

                if (command.entities) {
                    const entitiesId = command.entities;
                    const parameters = command.parameters;
                    const entities = this.entities.filter((entity) =>
                        entitiesId.includes(entity.id),
                    );
                    if (!entities) {
                        Logger.error(
                            `Entity with id ${entitiesId} not found in the entities list`,
                        );
                        continue;
                    }
                    for (const entity of entities) {
                        const functionName = command.name;
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
                            Logger.error(
                                'Error while executing the command: ' + error,
                            );
                        }
                    }
                }
                story.addStep('system', result);
            }
        }
        story.Save();
        return story;
    }

    async getQueries(order: Order): Promise<LlmRouterQuery[]> {
        const LLM = 'Router';
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
