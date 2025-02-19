import LlmController from '../Controller/LlmController';
import Story from '../Object/Story';
import {
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
        const maxTurns = category === 'browser' ? 10 : 5;
        let globalshouldBreak = false;
        for (let turn = 0; turn <= maxTurns; turn++) {
            if (globalshouldBreak) {
                break;
            }
            const response = (await this.llmController.sendToLlm(
                category,
                story.content,
            )) as LlmResponse;
            story.addAssistantStep(response);

            let globalResult = 'Result for each commands:';
            for (const command of response.commands) {
                const { result, shouldBreak } =
                    await this.CommandExecutor.evalCommand(command);
                globalResult += result;
                Logger.debug(result);
                globalshouldBreak = shouldBreak;
            }
            story.addStep('system', globalResult);
        }

        story.Save();
        return story;
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
