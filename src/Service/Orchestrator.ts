import LlmController from '../Controller/LlmController';
import Story from '../Entity/Story';
import { Category, Order } from '../types/types';
import Logger from '../Logger';

export default class Orchestrator {
    constructor(private readonly llmController = new LlmController()) {}

    async aNewStoryBegin(order: Order): Promise<Story> {
        //const category = await this.getStoryCategory(order);
        //const story = new Story(category, order.content);
        //let response = await this.llmController.sendToLlm(
        //    category,
        //    story.stringify(),
        //);
        const category = 'domotic' as Category;
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

    async getStoryCategory(order: Order): Promise<Category> {
        const LLM = 'Router';
        //const result = await this.llmController.sendToLlm(LLM, order.content);
        const result = { category: LLM };
        console.log(result);
        Logger.debug(
            `Order ${order.content} got categorized as ${result.category}`,
        );
        return 'Browser';
    }
}
