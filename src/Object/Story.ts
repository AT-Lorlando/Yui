import { Category, Role, StoryMessage, LlmResponse } from '../types/types';
import Logger from '../Logger';
import fs from 'fs';
class Story {
    public resume: string | undefined;
    public content = [] as StoryMessage[];
    public id = Date.now();

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
        for (let i = 0; i < response.commands.length; i++) {
            const command = response.commands[i];
            content += `{"name":"${command.name}"`;
            if (command.entities) {
                content += `,"entities":[${command.entities.join(',')}]`;
            }
            if (command.parameters) {
                content += `,"parameters":{`;
                const keys = Object.keys(command.parameters);
                for (let j = 0; j < keys.length; j++) {
                    const key = keys[j];
                    content += `"${key}":${command.parameters[key]}`;
                    if (j !== keys.length - 1) {
                        content += ',';
                    }
                }
                content += '}';
            }
            content += '}';
            if (i !== response.commands.length - 1) {
                content += ',';
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
            if (step.content) {
                result += `{"role":"${step.role}","content":"${step.content
                    .replace(/"/g, '\\"')
                    .replace(/\n/g, '\\n')
                    .trim()}"}`;
            } else if (step.commands) {
                result += `{"role":"${step.role}","commands":${step.commands}}`;
            } else if (step.output) {
                result += `{"role":"${step.role}","output":${step.output}}`;
            }
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
