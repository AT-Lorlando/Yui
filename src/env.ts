import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

export interface Env {
    NODE_ENV: 'development' | 'production';
    OPENAI_API_KEY: string;
    LOG_LEVEL: 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly';
    HUE_BRIDGE_IP: string | undefined;
    HUE_USERNAME: string | undefined;
    BEARER_TOKEN: string;
    NOTIFYMYDEVICE_API_KEY: string | undefined;
    SPOTIFY_CLIENT_ID: string | undefined;
    SPOTIFY_CLIENT_SECRET: string | undefined;
    SPOTIFY_REDIRECT_URI: string | undefined;
}

export const env: Env = {
    NODE_ENV: process.env.NODE_ENV as Env['NODE_ENV'],
    OPENAI_API_KEY: process.env.OPENAI_API_KEY as Env['OPENAI_API_KEY'],
    LOG_LEVEL: process.env.LOG_LEVEL as Env['LOG_LEVEL'],
    HUE_BRIDGE_IP: process.env.HUE_BRIDGE_IP as Env['HUE_BRIDGE_IP'],
    HUE_USERNAME: process.env.HUE_USERNAME as Env['HUE_USERNAME'],
    BEARER_TOKEN: process.env.BEARER_TOKEN as Env['BEARER_TOKEN'],
    NOTIFYMYDEVICE_API_KEY: process.env
        .NOTIFYMYDEVICE_API_KEY as Env['NOTIFYMYDEVICE_API_KEY'],
    SPOTIFY_CLIENT_ID: process.env
        .SPOTIFY_CLIENT_ID as Env['SPOTIFY_CLIENT_ID'],
    SPOTIFY_CLIENT_SECRET: process.env
        .SPOTIFY_CLIENT_SECRET as Env['SPOTIFY_CLIENT_SECRET'],
    SPOTIFY_REDIRECT_URI: process.env
        .SPOTIFY_REDIRECT_URI as Env['SPOTIFY_REDIRECT_URI'],
};

export default env;
