import LlmController from '../Controller/LlmController';
import Story from '../Entity/Story';
import {
    BrowserCommand,
    Category,
    DomoticCommand,
    GeneralCommand,
    Order,
    StoryContent,
} from '../types/types';
import Logger from '../Logger';
import CommandExecutor from './CommandExecutor';
import Entity from '../Entity/Entity';

export default class Orchestrator {
    public entities: Entity[];
    constructor(
        private readonly CommandExecutor: CommandExecutor,
        private readonly llmController = new LlmController(),
    ) {
        this.entities = CommandExecutor.entities;
    }

    async aNewStoryBegin(order: Order): Promise<Story> {
        const category = await this.getOrderCategory(order);
        let systemPrompt = await this.llmController.getLlmSystemPrompt(
            category,
        );
        systemPrompt = systemPrompt.replace(
            '<entities_placeholder>',
            this.entities.map((entity) => entity.__str__()).join('\n'),
        );

        const story = new Story(category, systemPrompt, order.content);
        let shouldBreak = false;

        for (let turn = 0; turn <= 5; turn++) {
            if (shouldBreak) {
                break;
            }

            const response = await this.llmController.sendToLlm(
                category,
                story.content,
            );
            story.addAssistantStep(response);
            let result = 'Result for each commands:\n';

            for (let command of response.commands) {
                if (String(command.name) === 'Say') {
                    command = command as GeneralCommand;
                    Logger.info('Plugin: Evaluating Say command');
                    Logger.info(command.parameters.text);
                    shouldBreak = true;
                    break;
                }

                if (command.name === 'AskUser') {
                    story.addStep('user', result);
                } else {
                    command = command as DomoticCommand | BrowserCommand;
                    Logger.info(
                        'Plugin: Evaluating ' +
                            command.name +
                            ' command with ' +
                            command.parameters.entity +
                            ' and ' +
                            command.parameters.stateChanges.map(
                                (stateChange) =>
                                    stateChange.property +
                                    ':' +
                                    stateChange.value,
                            ),
                    );
                    result +=
                        `\n${command.name}(${command.parameters.entity}): ` +
                        (await this.evaluateCommand(
                            command.name,
                            command.parameters,
                        ));
                }
            }
            story.addStep('system', result);
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

    async evaluateCommand(command: string, parameters: any): Promise<string> {
        const entity = parseInt(parameters.entity);
        const state = parameters.stateChanges;
        switch (command) {
            case 'SetEntityState':
                try {
                    await this.CommandExecutor.setEntityState(entity, state);
                    return 'Entity state set';
                } catch (e) {
                    if (e instanceof Error) {
                        return e.message;
                    } else {
                        return String(e);
                    }
                }
            default:
                return 'Command not found';
        }
    }
}
