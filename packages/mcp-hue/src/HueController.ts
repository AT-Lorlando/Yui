import { v3 } from 'node-hue-api';
import Logger from './logger';

interface RoomGroup {
    id: number;
    name: string;
    lightIds: number[];
}

export default class HueController {
    private api: any;
    private groupCache: RoomGroup[] = [];

    constructor(api: any) {
        this.api = api;
    }

    // ── Startup cache ──────────────────────────────────────────────────────────

    /** Fetch all Room groups from the Hue bridge and cache them. */
    public async initCache(): Promise<void> {
        const groups = await this.api.groups.getAll();
        this.groupCache = groups
            .filter((g: any) => g.type === 'Room' || g.type === 'Zone')
            .map((g: any) => ({
                id: Number(g.id),
                name: String(g.name),
                lightIds: (g.lights ?? []).map(Number),
            }));
        Logger.info(`Room cache: ${this.groupCache.map((g) => g.name).join(', ')}`);
    }

    public getRoomNames(): string[] {
        return this.groupCache.map((g) => g.name);
    }

    private findGroup(roomName: string): RoomGroup | null {
        const lc = roomName.toLowerCase().trim();
        return (
            this.groupCache.find((g) => g.name.toLowerCase() === lc) ??
            this.groupCache.find(
                (g) =>
                    g.name.toLowerCase().includes(lc) ||
                    lc.includes(g.name.toLowerCase()),
            ) ??
            null
        );
    }

    // ── Colour helpers ─────────────────────────────────────────────────────────

    private hexToHueSat(hex: string): { hue: number; sat: number } {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!result) throw new Error(`Invalid hex color: ${hex}`);
        const r = parseInt(result[1], 16) / 255;
        const g = parseInt(result[2], 16) / 255;
        const b = parseInt(result[3], 16) / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0;
        let s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return { hue: Math.round(h * 65535), sat: Math.round(s * 254) };
    }

    // ── High-level room control (uses Hue Groups API — single API call) ────────

    /**
     * Control all lights in a room via the Hue Groups API.
     * One PUT /groups/{id}/action call — no per-light iteration needed.
     *
     * @param roomName  Room name (fuzzy-matched against cached groups)
     * @param on        true = on, false = off (defaults to true)
     * @param brightness  0–100 %
     * @param color     Hex color string, e.g. "#FF5500"
     */
    public async setRoomLights(
        roomName: string,
        opts: { on?: boolean; brightness?: number; color?: string },
    ): Promise<string> {
        const group = this.findGroup(roomName);
        if (!group) {
            const available = this.getRoomNames().join(', ');
            throw new Error(
                `Pièce "${roomName}" introuvable. Pièces disponibles : ${available}`,
            );
        }

        const state = new v3.lightStates.LightState();

        // Default to on=true unless explicitly turning off
        const turnOn = opts.on !== false;
        state.on(turnOn);

        if (turnOn) {
            if (opts.brightness !== undefined) {
                const bri = Math.max(1, Math.round((opts.brightness / 100) * 254));
                state.brightness(bri);
            }
            if (opts.color !== undefined) {
                const { hue, sat } = this.hexToHueSat(opts.color);
                state.hue(hue).sat(sat);
            }
        }

        await this.api.groups.setGroupState(group.id, state);

        const parts: string[] = [];
        if (!turnOn) {
            parts.push('éteint');
        } else {
            if (opts.brightness !== undefined) parts.push(`luminosité ${opts.brightness}%`);
            else parts.push('allumé');
            if (opts.color) parts.push(`couleur ${opts.color}`);
        }

        const msg = `${group.name} : ${parts.join(', ')}`;
        Logger.info(`Room control — ${msg}`);
        return msg;
    }

    // ── Individual light control ───────────────────────────────────────────────

    public async getAllGroups(): Promise<{ name: string; lights: string[] }[]> {
        const groups = await this.api.groups.getAll();
        return groups
            .filter((g: any) => g.type === 'Room')
            .map((g: any) => ({ name: g.name, lights: g.lights }));
    }

    public async getAllLights(): Promise<any[]> {
        const returnLights: any[] = [];
        const lights = await this.api.lights.getAll();
        lights.map((light: any) => {
            Logger.debug(`Light found: ID=${light.id}, Name=${light.name}`);
            returnLights.push({ id: light.id, name: light.name, state: light.state });
        });
        if (returnLights.length === 0) throw new Error('No lights found.');
        return returnLights;
    }

    public async getLightById(id: number): Promise<any> {
        const light = await this.api.lights.getLight(id);
        Logger.debug(`Light found: ID=${light.id}, Name=${light.name}`);
        if (!light) throw new Error('No light found.');
        return light;
    }

    public async setLightState(lightId: number, on: boolean): Promise<void> {
        await this.getLightById(lightId);
        const lightState = new v3.lightStates.LightState().on(on);
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(`Light ${lightId} turned ${on ? 'on' : 'off'}`);
    }

    public async setLightBrightness(lightId: number, brightness: number): Promise<void> {
        await this.getLightById(lightId);
        const lightState = new v3.lightStates.LightState().on().brightness(brightness);
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(`Light ${lightId} brightness set to ${brightness}`);
    }

    public async setLightColor(lightId: number, color: string): Promise<void> {
        await this.getLightById(lightId);
        const { hue, sat } = this.hexToHueSat(color);
        const lightState = new v3.lightStates.LightState().on().hue(hue).sat(sat);
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(`Light ${lightId} color set to ${color}`);
    }

    public async getLightState(lightId: number): Promise<any> {
        const light = await this.getLightById(lightId);
        return light.state;
    }

    /** Turn all lights on or off in parallel. Skips per-light validation for speed. */
    public async setAllLightsState(
        lightIds: number[],
        on: boolean,
        brightness?: number,
    ): Promise<void> {
        const lightState = new v3.lightStates.LightState().on(on);
        if (on && brightness !== undefined) lightState.brightness(brightness);
        await Promise.all(
            lightIds.map((id) => this.api.lights.setLightState(id, lightState)),
        );
        Logger.info(`All lights (${lightIds.length}) turned ${on ? 'on' : 'off'}`);
    }
}
