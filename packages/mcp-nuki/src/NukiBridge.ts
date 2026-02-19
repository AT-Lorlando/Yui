import axios from 'axios';
import Logger from './logger';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class NukiBridge {
    /**
     * Prod mode: read NUKI_HOST, NUKI_PORT, NUKI_TOKEN from env.
     * Throws if NUKI_HOST or NUKI_TOKEN are missing.
     */
    static connect(): { host: string; port: string; token: string } {
        const host = process.env.NUKI_HOST;
        const port = process.env.NUKI_PORT || '8080';
        const token = process.env.NUKI_TOKEN;

        if (!host) {
            throw new Error(
                'NUKI_HOST is not set. Run "npm run setup:nuki" to configure the bridge.',
            );
        }
        if (!token) {
            throw new Error(
                'NUKI_TOKEN is not set. Run "npm run setup:nuki" to configure the bridge.',
            );
        }

        Logger.info(`Nuki bridge configured at http://${host}:${port}`);
        return { host, port, token };
    }

    /**
     * Request a new API token from the Nuki Bridge.
     * Requires the bridge button to be pressed within 30 seconds.
     * The bridge must have "Allow access" enabled in the Nuki app.
     */
    static async createToken(
        host: string,
        port: string,
    ): Promise<string> {
        const baseUrl = `http://${host}:${port}`;

        Logger.info(
            'Press the button on the Nuki Bridge within the next 30 seconds.',
        );

        let token: string | undefined;
        let attempts = 0;
        const maxAttempts = 6;

        while (!token && attempts < maxAttempts) {
            try {
                const response = await axios.get(`${baseUrl}/auth`, {
                    timeout: 10000,
                });
                if (response.data?.token) {
                    token = response.data.token;
                }
            } catch {
                attempts += 1;
                await sleep(5 * 1000);
            }
        }

        if (!token) {
            throw new Error(
                'Failed to create token. Make sure you pressed the bridge button and "Allow access" is enabled in the Nuki app.',
            );
        }

        Logger.info('Token created successfully.');
        return token;
    }
}
