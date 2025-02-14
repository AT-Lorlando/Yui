import Logger from '../Logger';
import { promises as fs } from 'fs';
import { getChatCompletion } from '../Service/MockOpenAi';
import { removeJsonComments } from '../Service/JsonUtils';
import {
    Category,
    StoryMessage,
    LlmRouterResponse,
    LlmResponse,
} from '../types/types';
export default class LlmController {
    async sendToLlm(
        category: Category,
        payload: StoryMessage[],
    ): Promise<LlmResponse | LlmRouterResponse> {
        const systemPrompt = await this.getLlmSystemPrompt(category);
        const finalPayload = [
            { role: 'system', content: systemPrompt } as StoryMessage,
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
            if (!('queries' in parsed)) {
                throw new Error(
                    'No Queries inside a Router response ' + response,
                );
            }
        }
        // } else {
        //     if (!('commands' in parsed)) {
        //         throw new Error(
        //             `No Commands inside a ${category} response ` + response,
        //         );
        //     }
        // }
        return parsed;
    }

    public async getLlmSystemPrompt(category: Category): Promise<string> {
        const filePath = `./assets/prompts/${category.toLowerCase()}.md`;
        const data = await fs.readFile(filePath, 'utf-8');
        const prompt = data.replace(/```json/g, '').replace(/```/g, '');
        return prompt;
    }

    private async generate(payload: StoryMessage[]): Promise<string> {
        const response = await getChatCompletion(payload);
        Logger.debug('Sending: ' + payload[payload.length - 1].content);
        Logger.debug('Response from OpenAI: ' + response);
        return response || '';
    }
}
