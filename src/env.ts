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
    // Presence detection
    HOME_LAT: string | undefined;
    HOME_LNG: string | undefined;
    PHONE_MAC: string | undefined;
    PRESENCE_AWAY_TIMEOUT_MIN: string;
    PRESENCE_ARRIVAL_RADIUS_M: string;
    PRESENCE_DEPARTURE_RADIUS_M: string;
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
    HOME_LAT: process.env.HOME_LAT,
    HOME_LNG: process.env.HOME_LNG,
    PHONE_MAC: process.env.PHONE_MAC,
    PRESENCE_AWAY_TIMEOUT_MIN: process.env.PRESENCE_AWAY_TIMEOUT_MIN ?? '15',
    PRESENCE_ARRIVAL_RADIUS_M: process.env.PRESENCE_ARRIVAL_RADIUS_M ?? '200',
    PRESENCE_DEPARTURE_RADIUS_M:
        process.env.PRESENCE_DEPARTURE_RADIUS_M ?? '500',
};

export default env;
