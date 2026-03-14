import axios, { AxiosInstance } from 'axios';
import https from 'https';
import Logger from './logger';

const BASE_PATH = '/enduser-mobile-web/enduserAPI';

// uiClass values that correspond to controllable covers
const COVER_UI_CLASSES = new Set([
    'RollerShutter',
    'Awning',
    'ExteriorBlind',
    'Gate',
    'GarageDoor',
    'Pergola',
    'Window',
    'Screen',
    'Curtain',
    'SwimmingPool', // pool pump — open/close maps to on/off
]);

export interface TahomaDevice {
    deviceURL: string;
    label: string;
    uiClass: string;
    widget: string;
    controllableName: string;
    states: { name: string; type: number; value: unknown }[];
}

export interface CoverDevice {
    url: string;
    name: string;
    uiClass: string;
    /** Closure 0=fully open, 100=fully closed. null if device doesn't report position. */
    position: number | null;
}

export class TahomaClient {
    private client: AxiosInstance;
    private sessionCookie: string | null = null;
    private readonly email: string;
    private readonly password: string;
    private deviceCache: TahomaDevice[] = [];

    constructor(host: string, port: number, email: string, password: string) {
        this.email = email;
        this.password = password;
        this.client = axios.create({
            baseURL: `https://${host}:${port}${BASE_PATH}`,
            // TaHoma uses a self-signed certificate
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 15_000,
        });
    }

    async login(): Promise<void> {
        const params = new URLSearchParams();
        params.append('login', this.email);
        params.append('password', this.password);

        const res = await this.client.post('/login', params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const setCookie = res.headers['set-cookie'];
        if (!setCookie) throw new Error('TaHoma login failed: no session cookie');

        const match = setCookie.join(';').match(/JSESSIONID=([^;]+)/);
        if (!match) throw new Error('TaHoma login failed: JSESSIONID not found');

        this.sessionCookie = match[1];
        Logger.info('TaHoma: authenticated');
    }

    private authHeaders(): Record<string, string> {
        if (!this.sessionCookie) throw new Error('TaHoma: not logged in');
        return { Cookie: `JSESSIONID=${this.sessionCookie}` };
    }

    /** Re-authenticates once on 401 before failing. */
    private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
        if (!this.sessionCookie) await this.login();
        try {
            return await fn();
        } catch (err: any) {
            if (err?.response?.status === 401) {
                Logger.info('TaHoma: session expired, re-authenticating');
                this.sessionCookie = null;
                await this.login();
                return await fn();
            }
            throw err;
        }
    }

    /** Fetch all devices from the hub and cache them. */
    async fetchDevices(): Promise<TahomaDevice[]> {
        return this.withAuth(async () => {
            const res = await this.client.get<TahomaDevice[]>('/setup/devices', {
                headers: this.authHeaders(),
            });
            this.deviceCache = res.data;
            Logger.info(`TaHoma: ${this.deviceCache.length} devices fetched`);
            return this.deviceCache;
        });
    }

    /** Returns cached cover devices with their current position state. */
    listCovers(): CoverDevice[] {
        return this.deviceCache
            .filter((d) => COVER_UI_CLASSES.has(d.uiClass))
            .map((d) => {
                const closureState = d.states?.find(
                    (s) => s.name === 'core:ClosureState',
                );
                return {
                    url: d.deviceURL,
                    name: d.label,
                    uiClass: d.uiClass,
                    position: closureState != null ? Number(closureState.value) : null,
                };
            });
    }

    /** Resolve a device by URL or by label (case-insensitive). */
    resolveDevice(nameOrUrl: string): TahomaDevice | undefined {
        if (nameOrUrl.includes('://')) {
            return this.deviceCache.find((d) => d.deviceURL === nameOrUrl);
        }
        const lc = nameOrUrl.toLowerCase();
        return this.deviceCache.find((d) => d.label.toLowerCase().includes(lc));
    }

    /** Execute a command on one device. Returns execId. */
    async exec(
        deviceURL: string,
        command: string,
        parameters: unknown[] = [],
        label?: string,
    ): Promise<string> {
        return this.withAuth(async () => {
            const res = await this.client.post<{ execId: string }>(
                '/exec/apply',
                {
                    label: label ?? command,
                    actions: [
                        {
                            deviceURL,
                            commands: [{ name: command, parameters }],
                        },
                    ],
                },
                { headers: this.authHeaders() },
            );
            return res.data?.execId ?? 'ok';
        });
    }

    async getCurrentExecutions(): Promise<{ id: string; label: string }[]> {
        return this.withAuth(async () => {
            const res = await this.client.get<{ id: string; label: string }[]>(
                '/exec/current',
                { headers: this.authHeaders() },
            );
            return res.data ?? [];
        });
    }

    async cancelExecution(execId: string): Promise<void> {
        return this.withAuth(async () => {
            await this.client.delete(`/exec/current/${execId}`, {
                headers: this.authHeaders(),
            });
        });
    }

    /**
     * Fetch fresh states for a single device (live, bypasses cache).
     */
    async getDeviceStates(
        deviceURL: string,
    ): Promise<{ name: string; value: unknown }[]> {
        return this.withAuth(async () => {
            const encoded = encodeURIComponent(deviceURL);
            const res = await this.client.get<{ name: string; value: unknown }[]>(
                `/setup/devices/${encoded}/states`,
                { headers: this.authHeaders() },
            );
            return res.data ?? [];
        });
    }
}
