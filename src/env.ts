import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

export interface Env {
    NODE_ENV: 'development' | 'production';
    LLM_API_KEY: string;
    LLM_BASE_URL: string | undefined;
    LLM_MODEL: string;
    LOG_LEVEL: 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly';
    HUE_BRIDGE_IP: string | undefined;
    HUE_USERNAME: string | undefined;
    BEARER_TOKEN: string;
    NUKI_TOKEN: string;
    NUKI_HOST: string;
    NUKI_PORT: string;
    SAVE_STORIES: boolean;
}

export const env: Env = {
    NODE_ENV: (process.env.NODE_ENV as Env['NODE_ENV']) ?? 'development',
    LLM_API_KEY: (process.env.LLM_API_KEY ??
        process.env.OPENAI_API_KEY) as string,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_MODEL: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    LOG_LEVEL: (process.env.LOG_LEVEL as Env['LOG_LEVEL']) ?? 'info',
    HUE_BRIDGE_IP: process.env.HUE_BRIDGE_IP,
    HUE_USERNAME: process.env.HUE_USERNAME,
    BEARER_TOKEN: process.env.BEARER_TOKEN as string,
    NUKI_TOKEN: process.env.NUKI_TOKEN as string,
    NUKI_HOST: process.env.NUKI_HOST as string,
    NUKI_PORT: process.env.NUKI_PORT ?? '8080',
    SAVE_STORIES: process.env.SAVE_STORIES === 'true',
};

export default env;
