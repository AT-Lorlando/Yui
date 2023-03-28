export interface Env {
  NODE_ENV: 'development' | 'production';
}

export const env: Env = {
    NODE_ENV: process.env.NODE_ENV as Env['NODE_ENV'],
};
