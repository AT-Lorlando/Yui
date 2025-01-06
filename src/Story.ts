import { Category, Role, StoryContent, LlmResponse } from '../types/types';
import { logger } from './logger';

class Story {
    public resume: string | undefined;
    public content = [] as StoryContent;

    constructor(
        public category: Category,
        order: string,
        public readonly createdAt: Date = new Date(),
    ) {
        this.content = [];
        this.addStep('user', order);
    }

    public addStep(role: Role, content: string) {
        this.content.push({
            role,
            content,
        });
    }

    public addAssistantStep(response: LlmResponse) {
        let content = `{"commands":[`;
        for (const command of response.commands) {
            content += `"command":${command.name}","payload":"${command.parameters}"`;
        }
        content += ']}';
        this.addStep('assistant', content);
    }

    public stringify() {
        let result = '';
        for (const step of this.content) {
            result += `{"role":"${step.role}","content":"${step.content}"}`;
        }
        return result;
    }

    public Save(): void {
        logger.info('Story save' + this.createdAt);
        logger.debug(this.stringify());
    }
}

export default Story;
