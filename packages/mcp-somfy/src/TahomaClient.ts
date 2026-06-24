import axios, { AxiosInstance } from 'axios';
import https from 'https';
import Logger from './logger';

const BASE_PATH = '/enduser-mobile-web/1/enduserAPI';

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
    controllableName: string;
    definition: { uiClass: string; widgetName: string };
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
    private deviceCache: TahomaDevice[] = [];

    constructor(host: string, port: number, token: string) {
        this.client = axios.create({
            baseURL: `https://${host}:${port}${BASE_PATH}`,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 15_000,
            headers: { Authorization: `Bearer ${token}` },
        });
    }

    /** Fetch all devices from the hub and cache them. */
    async fetchDevices(): Promise<TahomaDevice[]> {
        const res = await this.client.get<{ devices: TahomaDevice[] }>(
            '/setup',
        );
        this.deviceCache = res.data.devices ?? [];
        Logger.debug(`TaHoma: ${this.deviceCache.length} devices fetched`);
        return this.deviceCache;
    }

    /** Returns cached cover devices with their current position state. */
    listCovers(): CoverDevice[] {
        return this.deviceCache
            .filter((d) => COVER_UI_CLASSES.has(d.definition?.uiClass))
            .map((d) => {
                const closureState = d.states?.find(
                    (s) => s.name === 'core:ClosureState',
                );
                return {
                    url: d.deviceURL,
                    name: d.label,
                    uiClass: d.definition.uiClass,
                    position:
                        closureState != null
                            ? Number(closureState.value)
                            : null,
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
        const res = await this.client.post<{ execId: string }>('/exec/apply', {
            label: label ?? command,
            actions: [
                {
                    deviceURL,
                    commands: [{ name: command, parameters }],
                },
            ],
        });
        return res.data?.execId ?? 'ok';
    }

    async getCurrentExecutions(): Promise<{ id: string; label: string }[]> {
        const res = await this.client.get<{ id: string; label: string }[]>(
            '/exec/current',
        );
        return res.data ?? [];
    }

    async cancelExecution(execId: string): Promise<void> {
        await this.client.delete(`/exec/current/${execId}`);
    }

    async getDeviceStates(
        deviceURL: string,
    ): Promise<{ name: string; value: unknown }[]> {
        const encoded = encodeURIComponent(deviceURL);
        const res = await this.client.get<{ name: string; value: unknown }[]>(
            `/setup/devices/${encoded}/states`,
        );
        return res.data ?? [];
    }
}
