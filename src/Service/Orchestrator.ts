import LlmController from '../Controller/LlmController';
import Story from '../Entity/Story';
import { Category, Order, StoryContent } from '../types/types';
import Logger from '../Logger';
import CommandExecutor from './CommandExecutor';

export default class Orchestrator {
    constructor(
        private readonly CommandExecutor: CommandExecutor,
        private readonly llmController = new LlmController(),
    ) {}

    async aNewStoryBegin(order: Order): Promise<Story> {
        const category = await this.getOrderCategory(order);
        const story = new Story(category, order.content);
        let response = await this.llmController.sendToLlm(
            category,
            story.content,
        );
        const systemPrompt = await this.llmController.getLlmSystemPrompt(
            category,
        );
        story.addStep('system', systemPrompt);

        let shouldBreak = false;

        for (let turn = 0; turn <= 10; turn++) {
            if (shouldBreak) {
                break;
            }
            story.addAssistantStep(response);
            let result = '';
            for (const command of response.commands) {
                Logger.info(
                    'Plugin: Evaluating ' +
                        command.name +
                        ' command with ' +
                        command.parameters,
                );
                result += `Output ${command.name}(${command.parameters}): Success\n`;

                if (String(command.name) == 'Say') {
                    shouldBreak = true;
                    break;
                }
                if (command.name == 'AskUser') {
                    story.addStep('user', result);
                } else {
                    await this.evaluateCommand(
                        command.name,
                        command.parameters,
                    );
                    story.addStep('system', result);
                }
            }

            if (!shouldBreak) {
                response = await this.llmController.sendToLlm(
                    category,
                    story.content,
                );
            }
        }
        story.Save();
        return story;
    }

    async getOrderCategory(order: Order): Promise<Category> {
        const LLM = 'Router';
        const story = [
            {
                role: 'user',
                content: order.content,
            },
        ] as StoryContent;
        const result = await this.llmController.sendToLlm(LLM, story);
        Logger.debug(
            `Order ${order.content} got categorized as ${result.category}`,
        );
        return result.category;
    }

    async evaluateCommand(command: string, parameters: any): Promise<void> {
        const entity = parameters.entity;
        const state = parameters.stateChanges;
        Logger.info(entity);
        Logger.info(state);
        switch (command) {
            case 'setEntityState':
                return this.CommandExecutor.setEntityState(entity, state);
            default:
                return;
        }
    }
}
