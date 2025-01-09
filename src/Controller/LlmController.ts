import {
    Category,
    LlmResponse,
    RouterLlmResponse,
    DomoticLlmResponse,
    BrowserLlmResponse,
    GeneralLlmResponse,
    StoryContent,
    Content,
} from '../types/types';
import Logger from '../Logger';
import { promises as fs } from 'fs';
import { getChatCompletion } from '../Service/MockOpenAi';
import { removeJsonComments } from '../Service/JsonUtils';
export default class LlmController {
    public async sendToLlm(
        category: 'Router',
        payload: StoryContent,
    ): Promise<RouterLlmResponse>;
    public async sendToLlm(
        category: 'Browser',
        payload: StoryContent,
    ): Promise<BrowserLlmResponse>;
    public async sendToLlm(
        category: 'Domotic',
        payload: StoryContent,
    ): Promise<DomoticLlmResponse>;
    public async sendToLlm(
        category: 'General',
        payload: StoryContent,
    ): Promise<GeneralLlmResponse>;
    public async sendToLlm(
        category: Category,
        payload: StoryContent,
    ): Promise<LlmResponse>;

    async sendToLlm(
        category: Category,
        payload: StoryContent,
    ): Promise<LlmResponse | RouterLlmResponse> {
        const systemPrompt = await this.getLlmSystemPrompt(category);
        const finalPayload = [
            { role: 'system', content: systemPrompt } as Content,
            ...payload,
        ];
        return this.parseResponse(await this.generate(finalPayload), category);
    }

    private parseResponse(response: string, category: Category): LlmResponse {
        Logger.debug(`parsing ${response}`);
        let parsed = '';
        try {
            parsed = JSON.parse(removeJsonComments(response));
        } catch (error) {
            throw new Error(
                'Invalid response, the response is not a JSON\n' + response,
            );
        }
        if (typeof parsed !== 'object' || parsed === null) {
            throw new Error('JSON is not an object.');
        }
        if (category === 'Router') {
            if (!('category' in parsed)) {
                throw new Error(
                    'No Category inside a Router response ' + response,
                );
            }
        } else {
            if (!('commands' in parsed)) {
                throw new Error(
                    `No Commands inside a ${category} response ` + response,
                );
            }
        }
        return parsed;
    }

    public async getLlmSystemPrompt(category: Category): Promise<string> {
        const filePath = `./prompts/${category.toLowerCase()}.md`;
        const data = await fs.readFile(filePath, 'utf-8');
        const prompt = data.replace(/```json/g, '').replace(/```/g, '');
        return prompt;
    }

    private async generate(payload: StoryContent): Promise<string> {
        const response = await getChatCompletion(payload);
        Logger.info('Sending: ' + payload[payload.length - 1].content);
        Logger.info('Response from OpenAI: ' + response);
        return response || '';
    }
}
