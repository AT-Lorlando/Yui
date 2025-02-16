import { StoryMessage } from '../types/types';
import OpenAI from 'openai';

import env from '../env';
const OPENAI_API_KEY = env.OPENAI_API_KEY;

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface Choice {
    index: number;
    message: ChatMessage;
    finish_reason: string;
}

interface OpenAIResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Choice[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

const openai = new OpenAI({
    // baseURL: 'https://api.deepseek.com',
    // baseURL: 'https://api.openai.com/v1/chat/completions',
    apiKey: OPENAI_API_KEY,
});

export async function getChatCompletion(
    userMessage: StoryMessage[],
): Promise<string | null> {
    try {
        const data = (await openai.chat.completions.create({
            messages: userMessage as any,
            // model: 'deepseek-chat',
            model: 'gpt-4-turbo',
            // model: 'gpt-3.5-turbo',
        })) as OpenAIResponse;

        if (data.choices && data.choices.length > 0) {
            return data.choices[0].message.content.trim();
        } else {
            console.error('No choices returned from OpenAI API.');
            return null;
        }
    } catch (error) {
        console.error('Error while calling OpenAI API:', error);
        return null;
    }
}
