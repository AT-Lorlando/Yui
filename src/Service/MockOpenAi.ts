import { StoryContent } from '../types/types';
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

export async function getChatCompletion(
    userMessage: StoryContent,
): Promise<string | null> {
    try {
        const response: Response = await fetch(
            'https://api.openai.com/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                },
                body: JSON.stringify({
                    model: 'gpt-4-turbo',
                    messages: userMessage,
                }),
            },
        );

        if (!response.ok) {
            const errorData = await response.json();
            console.error('OpenAI API error:', errorData);
            return null;
        }

        const data: OpenAIResponse = await response.json();
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
