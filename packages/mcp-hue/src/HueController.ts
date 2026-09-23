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
        Logger.info(
            `Room cache: ${this.groupCache.map((g) => g.name).join(', ')}`,
        );
    }

    public getRoomNames(): string[] {
        return this.groupCache.map((g) => g.name);
    }

    /**
     * Pièce par nom : exact d'abord, puis partiel UNIQUEMENT si la cible est
     * plus courte que le nom de la pièce (« chamb » → Chambre). L'ancien
     * `cible.includes(pièce)` faisait passer « Plafond Chambre » pour la
     * pièce Chambre : le premier frame d'une intro allumait les 4 lampes
     * d'un coup (vu au bridge, 23/09) et toute commande sur cette lampe
     * touchait la pièce entière.
     */
    private findGroup(roomName: string): RoomGroup | null {
        const lc = roomName.toLowerCase().trim();
        if (!lc) return null;
        return (
            this.groupCache.find((g) => g.name.toLowerCase() === lc) ??
            this.groupCache.find(
                (g) =>
                    lc.length < g.name.length &&
                    g.name.toLowerCase().includes(lc),
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
                case r:
                    h = (g - b) / d + (g < b ? 6 : 0);
                    break;
                case g:
                    h = (b - r) / d + 2;
                    break;
                case b:
                    h = (r - g) / d + 4;
                    break;
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
    /** Kelvin → mirek, borné à la plage Hue (153 = froid 6500K, 500 = chaud 2000K). */
    private static kelvinToMirek(kelvin: number): number {
        return Math.max(153, Math.min(500, Math.round(1_000_000 / kelvin)));
    }

    public async setRoomLights(
        roomName: string,
        opts: {
            on?: boolean;
            brightness?: number;
            /** Variation relative en points de % (-100..100) — n'allume ni n'éteint. */
            brightnessDelta?: number;
            color?: string;
            /** Température de blanc en kelvin (2000 chaud – 6500 froid). Prime sur color. */
            colorTempK?: number;
            transitionMs?: number;
        },
    ): Promise<string> {
        const group = this.findGroup(roomName);
        if (!group) {
            const available = this.getRoomNames().join(', ');
            throw new Error(
                `Pièce "${roomName}" introuvable. Pièces disponibles : ${available}`,
            );
        }

        const state = new v3.lightStates.GroupLightState();

        // Un delta seul ne touche pas à l'alimentation : "baisse un peu" sur
        // une pièce partiellement éteinte ne doit pas rallumer les lampes
        // éteintes (bri_inc modifie le bri mémorisé, la lampe reste off).
        const deltaOnly =
            opts.brightnessDelta !== undefined && opts.on === undefined;
        // Default to on=true unless explicitly turning off
        const turnOn = opts.on !== false;
        if (!deltaOnly) state.on(turnOn);

        if (opts.brightnessDelta !== undefined && turnOn) {
            state.bri_inc(
                Math.max(
                    -254,
                    Math.min(
                        254,
                        Math.round((opts.brightnessDelta * 254) / 100),
                    ),
                ),
            );
        }
        if (turnOn) {
            if (opts.brightness !== undefined) {
                state.brightness(opts.brightness);
            }
            if (opts.colorTempK !== undefined) {
                state.ct(HueController.kelvinToMirek(opts.colorTempK));
            } else if (opts.color !== undefined) {
                const { hue, sat } = this.hexToHueSat(opts.color);
                state.hue(hue).sat(sat);
            }
        }

        if (opts.transitionMs !== undefined) {
            state.transitiontime(Math.round(opts.transitionMs / 100));
        }
        await this.api.groups.setGroupState(group.id, state);

        const parts: string[] = [];
        if (!turnOn) {
            parts.push('éteint');
        } else {
            if (opts.brightnessDelta !== undefined)
                parts.push(
                    `luminosité ${opts.brightnessDelta > 0 ? '+' : ''}${
                        opts.brightnessDelta
                    }%`,
                );
            else if (opts.brightness !== undefined)
                parts.push(`luminosité ${opts.brightness}%`);
            else parts.push('allumé');
            if (opts.colorTempK !== undefined)
                parts.push(`blanc ${opts.colorTempK}K`);
            else if (opts.color) parts.push(`couleur ${opts.color}`);
        }

        const msg = `${group.name} : ${parts.join(', ')}`;
        Logger.info(`Room control — ${msg}`);
        return msg;
    }

    // ── Palette (per-light color distribution) ────────────────────────────────

    /**
     * Distribute colors cyclically across all lights in a room.
     * Each light gets colors[i % colors.length] — wraps around if fewer colors
     * than lights. All lights are updated in parallel (one API call per light).
     */
    public async setRoomPalette(
        roomName: string,
        colors: string[],
        brightness?: number,
        transitionMs?: number,
    ): Promise<string> {
        const group = this.findGroup(roomName);
        if (!group) {
            const available = this.getRoomNames().join(', ');
            throw new Error(
                `Pièce "${roomName}" introuvable. Pièces disponibles : ${available}`,
            );
        }
        if (colors.length === 0)
            throw new Error('Au moins une couleur requise.');

        const bri = brightness;

        await Promise.all(
            group.lightIds.map((lightId, i) => {
                const { hue: h, sat: s } = this.hexToHueSat(
                    colors[i % colors.length],
                );
                const state = new v3.lightStates.LightState()
                    .on()
                    .hue(h)
                    .sat(s);
                if (bri !== undefined) state.brightness(bri);
                if (transitionMs !== undefined)
                    state.transitiontime(Math.round(transitionMs / 100));
                return this.api.lights.setLightState(lightId, state);
            }),
        );

        const parts = [`palette [${colors.join(', ')}]`];
        if (brightness !== undefined) parts.push(`luminosité ${brightness}%`);
        const msg = `${group.name} : ${parts.join(', ')}`;
        Logger.info(`Room palette — ${msg}`);
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
            returnLights.push({
                id: light.id,
                name: light.name,
                state: light.state,
            });
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

    /**
     * Écritures à envoyer pour UNE lampe, dans l'ordre. Pur, testé.
     *
     * Une seule écriture porte luminosité + couleur + transition : deux PUT
     * parallèles (l'ancien chemin) allumaient la lampe à son ancienne couleur
     * puis transitionnaient — « ça s'allume en rouge puis tout de suite bleu ».
     *
     * Départ en fondu (`fadeFrom`, ou lampe éteinte + transition + couleur) :
     * d'abord ON instantané à la luminosité de départ AVEC la couleur cible
     * (transitiontime 0 → aucun flash de l'ancien état), puis la rampe vers
     * la cible sur `transitionMs`. C'est ce qui rend un « chargement »
     * lampe par lampe possible.
     */
    public static planLightWrites(opts: {
        brightness?: number;
        color?: string;
        colorTempK?: number;
        transitionMs?: number;
        fadeFrom?: number;
        currentlyOff?: boolean;
        hueSat?: { hue: number; sat: number };
    }): Array<{
        on: true;
        bri?: number;
        hue?: number;
        sat?: number;
        ct?: number;
        transitiontime: number;
    }> {
        const colour: { hue?: number; sat?: number; ct?: number } =
            opts.colorTempK !== undefined
                ? { ct: HueController.kelvinToMirek(opts.colorTempK) }
                : opts.hueSat
                ? { hue: opts.hueSat.hue, sat: opts.hueSat.sat }
                : {};
        const hasColour = Object.keys(colour).length > 0;
        const target =
            opts.brightness !== undefined
                ? { bri: HueController.pctToBri(opts.brightness) }
                : {};
        const transition =
            opts.transitionMs !== undefined
                ? Math.round(opts.transitionMs / 100)
                : 0;
        const softStart =
            opts.fadeFrom !== undefined ||
            (opts.currentlyOff === true && transition > 0 && hasColour);
        if (softStart && transition > 0) {
            const from = HueController.pctToBri(opts.fadeFrom ?? 1);
            return [
                { on: true, bri: from, ...colour, transitiontime: 0 },
                {
                    on: true,
                    bri: target.bri ?? HueController.pctToBri(100),
                    transitiontime: transition,
                },
            ];
        }
        return [{ on: true, ...target, ...colour, transitiontime: transition }];
    }

    private static pctToBri(pct: number): number {
        return Math.max(1, Math.min(254, Math.round((pct * 254) / 100)));
    }

    /** Luminosité + couleur/blanc + transition en une seule écriture (cf. planLightWrites). */
    public async applyLightState(
        lightId: number,
        opts: {
            brightness?: number;
            color?: string;
            colorTempK?: number;
            transitionMs?: number;
            fadeFrom?: number;
            currentlyOff?: boolean;
        },
    ): Promise<void> {
        await this.getLightById(lightId);
        const plan = HueController.planLightWrites({
            ...opts,
            hueSat:
                opts.color !== undefined && opts.colorTempK === undefined
                    ? this.hexToHueSat(opts.color)
                    : undefined,
        });
        for (const step of plan) {
            const st = new v3.lightStates.LightState().on();
            if (step.bri !== undefined) st.bri(step.bri);
            if (step.hue !== undefined) st.hue(step.hue);
            if (step.sat !== undefined) st.sat(step.sat);
            if (step.ct !== undefined) st.ct(step.ct);
            st.transitiontime(step.transitiontime);
            await this.api.lights.setLightState(lightId, st);
        }
        Logger.info(
            `Light ${lightId} ← ${JSON.stringify({
                ...opts,
                plan: plan.length,
            })}`,
        );
    }

    public async setLightState(lightId: number, on: boolean): Promise<void> {
        await this.getLightById(lightId);
        const lightState = new v3.lightStates.LightState().on(on);
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(`Light ${lightId} turned ${on ? 'on' : 'off'}`);
    }

    public async setLightBrightness(
        lightId: number,
        brightness: number,
    ): Promise<void> {
        await this.getLightById(lightId);
        const lightState = new v3.lightStates.LightState()
            .on()
            .brightness(brightness);
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(`Light ${lightId} brightness set to ${brightness}`);
    }

    public async setLightColorTemp(
        lightId: number,
        kelvin: number,
        transitionMs?: number,
    ): Promise<void> {
        await this.getLightById(lightId);
        const lightState = new v3.lightStates.LightState()
            .on()
            .ct(HueController.kelvinToMirek(kelvin));
        if (transitionMs !== undefined)
            lightState.transitiontime(Math.round(transitionMs / 100));
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(`Light ${lightId} white set to ${kelvin}K`);
    }

    /** Variation relative en points de % — ne change pas l'état on/off. */
    public async incLightBrightness(
        lightId: number,
        deltaPct: number,
    ): Promise<void> {
        await this.getLightById(lightId);
        const lightState = new v3.lightStates.LightState().bri_inc(
            Math.max(-254, Math.min(254, Math.round((deltaPct * 254) / 100))),
        );
        await this.api.lights.setLightState(lightId, lightState);
        Logger.info(
            `Light ${lightId} brightness ${
                deltaPct > 0 ? '+' : ''
            }${deltaPct}%`,
        );
    }

    public async setLightColor(
        lightId: number,
        color: string,
        transitionMs?: number,
    ): Promise<void> {
        await this.getLightById(lightId);
        const { hue, sat } = this.hexToHueSat(color);
        const lightState = new v3.lightStates.LightState()
            .on()
            .hue(hue)
            .sat(sat);
        if (transitionMs !== undefined) {
            lightState.transitiontime(Math.round(transitionMs / 100));
        }
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
        Logger.info(
            `All lights (${lightIds.length}) turned ${on ? 'on' : 'off'}`,
        );
    }
}
