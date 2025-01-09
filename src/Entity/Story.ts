import { Category, Role, StoryContent, LlmResponse } from '../types/types';
import Logger from '../Logger';
import fs from 'fs';
class Story {
    public resume: string | undefined;
    public content = [] as StoryContent;
    private id = Math.floor(Math.random() * 1000000);

    constructor(
        public category: Category,
        public readonly systemPrompt: string,
        public readonly order: string,
        public readonly createdAt: Date = new Date(),
    ) {
        this.content = [];
        this.addStep('system', systemPrompt);
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
            content += `"command":${command.name}"`;
            if ('parameters' in command) {
                if (command.parameters.text) {
                    content += `,"text":"${command.parameters.text}"`;
                } else {
                    content += `,"payload":"{"entity":${
                        command.parameters.entity
                    }, "stateChanges":${command.parameters.stateChanges.map(
                        (stateChange) =>
                            `{"property":${stateChange.property},"value":${stateChange.value}}`,
                    )}"`;
                }
            }
        }
        content += ']}';
        this.addStep('assistant', content);
    }

    public stringify() {
        let result = '[';
        result += `{"role":"system","content":"SYSTEM PROMPT"},`;
        for (let i = 1; i < this.content.length; i++) {
            const step = this.content[i];
            result += `{"role":"${step.role}","content":"${step.content
                .replace(/"/g, '\\"')
                .replace(/\n/g, '\\n')
                .trim()}"}`;
            if (i !== this.content.length - 1) {
                result += ',';
            }
        }
        result += ']';
        return result;
    }

    public Save(): void {
        const data = this.stringify();
        fs.writeFileSync(`stories/story-${this.id}.json`, data);
        Logger.info('Story saved');
    }
}

export default Story;
