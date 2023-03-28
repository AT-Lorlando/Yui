require('dotenv').config({ path: '.env' });

export interface Env {
  NODE_ENV: 'development' | 'production';
  OPENAI_API_KEY: string;
}

export const env: Env = {
  NODE_ENV: process.env.NODE_ENV as Env['NODE_ENV'],
  OPENAI_API_KEY: process.env.OPENAI_API_KEY as Env['OPENAI_API_KEY'],
};

export default env;
