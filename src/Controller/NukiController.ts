import axios from 'axios';
import Logger from '../Logger';
import { env } from '../env';

export default class NukiController {
    private baseUrl: string | undefined;
    private token: string | undefined;
    private port: string | undefined;

    constructor() {
        if (!env.NUKI_TOKEN) {
            throw new Error('Missing NUKI_TOKEN in env');
        }
        if (!env.NUKI_HOST) {
            throw new Error('Missing NUKI_HOST in env');
        }
        this.port = env.NUKI_PORT;
        this.baseUrl = `http://${env.NUKI_HOST}:${this.port}`;
        this.token = env.NUKI_TOKEN;
        Logger.info(`NukiController connected with host: ${this.baseUrl}`);
    }

    public async getAllLocks(): Promise<any[]> {
        if (!this.baseUrl || !this.token) {
            throw new Error(
                'NukiController not initialized. Call init() first.',
            );
        }
        try {
            const url = `${this.baseUrl}/list?token=${this.token}`;
            Logger.debug(`Fetching all locks with GET: ${url}`);
            const response = await axios.get(url);
            Logger.debug(
                `Response from /list: ${JSON.stringify(response.data)}`,
            );

            if (!Array.isArray(response.data)) {
                throw new Error('Invalid response format from /list');
            }
            return response.data;
        } catch (error) {
            Logger.error('Error while fetching all locks:', error);
            throw error;
        }
    }

    public async getLockState(nukiId: number, deviceType = 0): Promise<any> {
        if (!this.baseUrl || !this.token) {
            throw new Error(
                'NukiController not initialized. Call init() first.',
            );
        }
        try {
            const url = `${this.baseUrl}/lockState?nukiId=${nukiId}&deviceType=${deviceType}&token=${this.token}`;
            Logger.debug(`Fetching lock state GET: ${url}`);
            const response = await axios.get(url);
            Logger.debug(
                `Response from /lockState: ${JSON.stringify(response.data)}`,
            );
            return response.data;
        } catch (error) {
            Logger.error(
                `Error while fetching lock state (nukiId=${nukiId}):`,
                error,
            );
            throw error;
        }
    }

    public async lock(
        nukiId: number,
        deviceType = 0,
        nowait = 0,
    ): Promise<any> {
        return this.lockAction(nukiId, 2, deviceType, nowait);
    }
    public async unlock(
        nukiId: number,
        deviceType = 0,
        nowait = 0,
    ): Promise<any> {
        return this.lockAction(nukiId, 1, deviceType, nowait);
    }

    public async lockAction(
        nukiId: number,
        action: number,
        deviceType = 0,
        nowait = 0,
    ): Promise<any> {
        if (!this.baseUrl || !this.token) {
            throw new Error('NukiController not initialized.');
        }
        try {
            const url = `${this.baseUrl}/lockAction?nukiId=${nukiId}&deviceType=${deviceType}&action=${action}&nowait=${nowait}&token=${this.token}`;
            Logger.debug(`Performing lockAction GET: ${url}`);
            const response = await axios.get(url);
            Logger.info(
                `Lock action ${action} on nukiId=${nukiId} result: ${JSON.stringify(
                    response.data,
                )}`,
            );
            return response.data;
        } catch (error) {
            Logger.error(
                `Error during lockAction=${action} (nukiId=${nukiId}):`,
                error,
            );
            throw error;
        }
    }
}
