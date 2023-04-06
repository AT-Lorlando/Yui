import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

export interface Env {
    NODE_ENV: 'development' | 'production';
    OPENAI_API_KEY: string;
    LOG_LEVEL: 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly';
    HUE_BRIDGE_IP: string | undefined;
    HUE_USERNAME: string | undefined;
}

export const env: Env = {
    NODE_ENV: process.env.NODE_ENV as Env['NODE_ENV'],
    OPENAI_API_KEY: process.env.OPENAI_API_KEY as Env['OPENAI_API_KEY'],
    LOG_LEVEL: process.env.LOG_LEVEL as Env['LOG_LEVEL'],
    HUE_BRIDGE_IP: process.env.HUE_BRIDGE_IP as Env['HUE_BRIDGE_IP'],
    HUE_USERNAME: process.env.HUE_USERNAME as Env['HUE_USERNAME'],
};

export default env;
