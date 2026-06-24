import axios from 'axios';
import { SmartThingsAuth } from './SmartThingsAuth';

const BASE = 'https://api.smartthings.com/v1';

export interface StCommand {
    component: string;
    capability: string;
    command: string;
    arguments?: unknown[];
}

export interface HttpTransport {
    post(
        url: string,
        body: unknown,
        headers: Record<string, string>,
    ): Promise<{ status: number; data: any }>;
    get(
        url: string,
        headers: Record<string, string>,
    ): Promise<{ status: number; data: any }>;
}

export interface StDevice {
    sendCommands(commands: StCommand[]): Promise<void>;
    getStatusRaw(): Promise<any>;
    getHealth(): Promise<'ONLINE' | 'OFFLINE'>;
    refresh(): Promise<void>;
}

export class TvOfflineError extends Error {
    constructor() {
        super('TV offline');
        this.name = 'TvOfflineError';
    }
}

const axiosTransport: HttpTransport = {
    async post(url, body, headers) {
        const r = await axios.post(url, body, { headers });
        return { status: r.status, data: r.data };
    },
    async get(url, headers) {
        const r = await axios.get(url, { headers });
        return { status: r.status, data: r.data };
    },
};

export class SmartThingsClient implements StDevice {
    constructor(
        private deviceId: string,
        private getToken: () => Promise<string> = SmartThingsAuth.getAccessToken,
        private http: HttpTransport = axiosTransport,
    ) {}

    private async headers(): Promise<Record<string, string>> {
        return { Authorization: `Bearer ${await this.getToken()}` };
    }

    async sendCommands(commands: StCommand[]): Promise<void> {
        try {
            await this.http.post(
                `${BASE}/devices/${this.deviceId}/commands`,
                { commands },
                await this.headers(),
            );
        } catch (e) {
            throw SmartThingsClient.translate(e);
        }
    }

    async getStatusRaw(): Promise<any> {
        const r = await this.http.get(
            `${BASE}/devices/${this.deviceId}/components/main/status`,
            await this.headers(),
        );
        return r.data;
    }

    async getHealth(): Promise<'ONLINE' | 'OFFLINE'> {
        const r = await this.http.get(
            `${BASE}/devices/${this.deviceId}/health`,
            await this.headers(),
        );
        return r.data?.state === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
    }

    async refresh(): Promise<void> {
        await this.sendCommands([
            { component: 'main', capability: 'refresh', command: 'refresh' },
        ]);
    }

    static translate(e: any): Error {
        const code = e?.response?.data?.error?.code ?? e?.response?.data?.code;
        if (code === 'ConflictError' || e?.response?.status === 409)
            return new TvOfflineError();
        return e instanceof Error ? e : new Error(String(e));
    }
}
