import axios from 'axios';
import NukiBridge from './NukiBridge';
import Logger from './logger';

interface DoorEntry {
    nukiId: number;
    name: string;
    deviceType: number;
}

export default class NukiController {
    private baseUrl: string;
    private token: string;
    private doorCache: DoorEntry[] = [];

    constructor() {
        const { host, port, token } = NukiBridge.connect();
        this.baseUrl = `http://${host}:${port}`;
        this.token = token;
        Logger.info(`NukiController connected with host: ${this.baseUrl}`);
    }

    // ── Startup cache ──────────────────────────────────────────────────────────

    public async initCache(): Promise<void> {
        const locks = await this.getAllLocks();
        this.doorCache = locks.map((l: any) => ({
            nukiId: Number(l.nukiId),
            name: String(l.name),
            deviceType: Number(l.deviceType ?? 0),
        }));
        Logger.info(`Door cache: ${this.doorCache.map((d) => d.name).join(', ')}`);
    }

    public getDoorNames(): string[] {
        return this.doorCache.map((d) => d.name);
    }

    private findDoor(name: string): DoorEntry | null {
        const lc = name.toLowerCase().trim();
        return (
            this.doorCache.find((d) => d.name.toLowerCase() === lc) ??
            this.doorCache.find(
                (d) =>
                    d.name.toLowerCase().includes(lc) ||
                    lc.includes(d.name.toLowerCase()),
            ) ??
            null
        );
    }

    public async controlDoor(name: string, action: 'lock' | 'unlock'): Promise<string> {
        const door = this.findDoor(name);
        if (!door) {
            const available = this.getDoorNames().join(', ');
            throw new Error(`Porte "${name}" introuvable. Portes disponibles : ${available}`);
        }
        if (action === 'lock') {
            await this.lock(door.nukiId, door.deviceType);
        } else {
            await this.unlock(door.nukiId, door.deviceType);
        }
        return `${door.name} : ${action === 'lock' ? 'verrouillée' : 'déverrouillée'}`;
    }

    public async getAllLocks(): Promise<any[]> {
        try {
            const url = `${this.baseUrl}/list?token=${this.token}`;
            Logger.debug(`Fetching all locks with GET: ${url}`);
            const response = await axios.get(url, { timeout: 10000 });
            Logger.debug(
                `GET /list response status=${response.status} data=${JSON.stringify(response.data)}`,
            );
            if (!Array.isArray(response.data)) {
                throw new Error(
                    `Invalid response format from /list: expected array, got ${typeof response.data} — ${JSON.stringify(response.data)}`,
                );
            }
            return response.data;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                const data = error.response?.data;
                Logger.error(
                    `GET /list failed: status=${status ?? 'no response'} ` +
                        `code=${error.code ?? 'none'} ` +
                        `data=${JSON.stringify(data)} ` +
                        `message=${error.message}`,
                );
            } else {
                Logger.error(
                    `Error while fetching all locks: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            throw error;
        }
    }

    public async getLockState(nukiId: number, deviceType = 0): Promise<any> {
        try {
            const url = `${this.baseUrl}/lockState?nukiId=${nukiId}&deviceType=${deviceType}&token=${this.token}`;
            Logger.debug(`Fetching lock state GET: ${url}`);
            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                Logger.error(
                    `GET /lockState failed (nukiId=${nukiId}): status=${error.response?.status ?? 'no response'} ` +
                        `code=${error.code ?? 'none'} message=${error.message}`,
                );
            } else {
                Logger.error(
                    `Error fetching lock state (nukiId=${nukiId}): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            throw error;
        }
    }

    public async lock(nukiId: number, deviceType = 0): Promise<any> {
        return this.lockAction(nukiId, 2, deviceType);
    }

    public async unlock(nukiId: number, deviceType = 0): Promise<any> {
        return this.lockAction(nukiId, 1, deviceType);
    }

    public async lockAction(
        nukiId: number,
        action: number,
        deviceType = 0,
        nowait = 0,
    ): Promise<any> {
        try {
            const url = `${this.baseUrl}/lockAction?nukiId=${nukiId}&deviceType=${deviceType}&action=${action}&nowait=${nowait}&token=${this.token}`;
            Logger.debug(`Performing lockAction GET: ${url}`);
            const response = await axios.get(url);
            Logger.info(
                `Lock action ${action} on nukiId=${nukiId} result: ${JSON.stringify(response.data)}`,
            );
            return response.data;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                Logger.error(
                    `GET /lockAction failed (nukiId=${nukiId}, action=${action}): status=${error.response?.status ?? 'no response'} ` +
                        `code=${error.code ?? 'none'} message=${error.message}`,
                );
            } else {
                Logger.error(
                    `Error during lockAction=${action} (nukiId=${nukiId}): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            throw error;
        }
    }
}
