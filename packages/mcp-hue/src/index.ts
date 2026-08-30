import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { EntityStore } from '@yui/shared';
import type { LightEntity } from '@yui/shared';
import HueBridge from './HueBridge';
import HueController from './HueController';
import GoveeClient from './GoveeClient';
import {
    startAmbiance,
    stopAmbiance,
    listAmbiance,
    stopAllAmbiance,
} from './GoveeAmbiance';
import { buildHueTools } from './tools';
import {
    isGovee,
    goveeTargetsForRoom,
    goveeTargetsForAll,
} from './goveeRouting';
import { coveredIds, othersToTurnOff, type BulkEntry } from './bulkStates';
import { discoverLights } from './discovery';
import { HueEventStream } from './HueEventStream';
import type { LightStatePatch } from './stateEvents';
import Logger from './logger';

let hue: HueController;
let HUE_TOOLS = buildHueTools([]);
const store = new EntityStore<LightEntity>('mcp-hue');

// Govee LAN devices indexed by their synthetic id ("g:1", "g:2", …)
const goveeById = new Map<string, GoveeClient>();
const goveeChannel = new Map<string, 'cct' | 'rgb'>(); // per-id channel routing

/**
 * Several logical devices can share one physical lamp (same IP, different
 * channel). Turning any of them off kills the lamp, so a running ambiance loop
 * on that IP must be stopped too — otherwise its next `colorwc` packet lights
 * the lamp right back up.
 */
function stopAmbianceOnLamp(ip: string): void {
    for (const [id, client] of goveeById) {
        if (client.ip === ip) stopAmbiance(id);
    }
}

interface GoveeOps {
    on?: boolean;
    brightness?: number;
    /** Variation relative en points de % — calculée depuis l'état du store. */
    brightnessDelta?: number;
    color?: string; // hex (#RRGGBB) — interpretation depends on channel
    /** Température de blanc en kelvin — colorwc kelvin, quel que soit le canal. */
    colorTempK?: number;
}

/** Rough hex → kelvin estimate for CCT channels. Warm reds → 2700, cold blues → 6500. */
function hexToKelvin(hex: string): number {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return 4000;
    const r = parseInt(m[1], 16);
    const b = parseInt(m[3], 16);
    // Pure white → 4000K, warm bias → 2700K, cool bias → 6500K
    if (r > b + 40) return 2700;
    if (b > r + 40) return 6500;
    if (r > b + 10) return 3200;
    if (b > r + 10) return 5500;
    return 4000;
}

async function applyGovee(
    g: GoveeClient,
    opts: GoveeOps,
    channel: 'cct' | 'rgb',
): Promise<void> {
    const turnOn = opts.on !== false;
    if (!turnOn) {
        // Shared physical device — caller is responsible for the trade-off
        // (turning off one logical light kills the whole lamp).
        await g.on(false);
        return;
    }
    // For CCT: color → kelvin, brightness applies globally.
    // For RGB: color → colorwc, brightness applies globally.
    if (opts.colorTempK !== undefined) {
        await g.colorTemperature(opts.colorTempK);
    } else if (channel === 'cct') {
        if (opts.color !== undefined)
            await g.colorTemperature(hexToKelvin(opts.color));
    } else {
        if (opts.color !== undefined) await g.color(opts.color);
    }
    if (opts.brightness !== undefined) await g.brightness(opts.brightness);
    if (
        opts.color === undefined &&
        opts.colorTempK === undefined &&
        opts.brightness === undefined &&
        opts.brightnessDelta === undefined
    ) {
        await g.on(true);
    }
}

/**
 * Fraîcheur de l'état des lampes.
 *
 * Le store ne connaît que nos propres écritures ; tout changement externe (app
 * Hue, interrupteur mural, télécommande gérée par le bridge) le laisserait
 * périmé. Le bridge pousse ces changements sur son flux SSE v2 : tant que le
 * flux est établi, le store est à jour en continu et `list_lights` n'a rien à
 * relire.
 *
 * Le filet : si le flux est tombé (bridge redémarré, réseau coupé), on
 * retombe sur une relecture avec TTL plutôt que de servir un état muet et
 * faux. `list_lights({refresh: true})` force une relecture complète.
 */
const FALLBACK_TTL_MS = Number(process.env.HUE_STATE_TTL_MS ?? 3000);
let lastStateRefresh = 0;
let refreshInFlight: Promise<void> | null = null;
let events: HueEventStream | null = null;

async function refreshHueState(force = false): Promise<void> {
    if (!force) {
        // Flux vivant → le store est déjà à jour.
        if (events?.isLive()) return;
        if (Date.now() - lastStateRefresh < FALLBACK_TTL_MS) return;
    }
    // Les appels concurrents partagent la même relecture.
    if (!refreshInFlight) {
        refreshInFlight = discoverLights(hue, store)
            .then(() => {
                lastStateRefresh = Date.now();
            })
            .catch((e) => {
                // Bridge injoignable : on garde le cache plutôt que d'échouer.
                Logger.warn(`[hue] state refresh failed: ${e}`);
            })
            .finally(() => {
                refreshInFlight = null;
            });
    }
    await refreshInFlight;
}

/** Applique au store ce que le bridge vient de pousser. */
function applyStatePatches(patches: LightStatePatch[]): void {
    for (const p of patches) {
        if (!store.getById(p.id)) continue;
        store.updateState(p.id, {
            ...(p.on !== undefined && { on: p.on }),
            ...(p.brightness !== undefined && { brightness: p.brightness }),
        });
    }
    Logger.debug(`[hue-events] ${patches.length} lampe(s) mise(s) à jour`);
}

async function startEventStream(): Promise<void> {
    const host = process.env.HUE_BRIDGE_IP;
    const key = process.env.HUE_USERNAME;
    if (!host || !key) {
        Logger.warn(
            '[hue-events] HUE_BRIDGE_IP/HUE_USERNAME absents — état rafraîchi par relecture périodique',
        );
        return;
    }
    events = new HueEventStream({
        host,
        key,
        onPatches: applyStatePatches,
        // À la reprise, des events ont pu être manqués : on resynchronise.
        onReconnect: () => {
            void refreshHueState(true);
        },
    });
    try {
        const mapped = await events.loadIdMap();
        Logger.info(`[hue-events] ${mapped} lampes mappées v2 → v1`);
    } catch (e) {
        Logger.warn(`[hue-events] mapping des ids indisponible: ${e}`);
    }
    events.start();
}

/** Hue ids are numeric, Govee ids are strings ("g:1") — keep them apart. */
function lightIdArg(v: unknown): string | number {
    const s = String(v);
    return isGovee(s) ? s : Number(v);
}

/** Apply a state to one registered Govee device by its synthetic id. */
async function applyGoveeById(id: string, opts: GoveeOps): Promise<void> {
    const g = goveeById.get(id);
    if (!g) throw new Error(`Govee device "${id}" not registered`);
    // Any off — and any explicit manual state — wins over a running ambiance
    // loop, which would otherwise keep overriding what we just set.
    if (opts.on === false) stopAmbianceOnLamp(g.ip);

    // Delta → valeur absolue depuis le store (Govee n'a pas de bri_inc).
    // Un delta seul n'allume pas une lampe éteinte.
    let resolved = opts;
    if (opts.brightnessDelta !== undefined) {
        const entity = store.getById(id);
        if (opts.on === undefined && entity?.state?.on === false) return;
        const current = Number(entity?.state?.brightness ?? 50);
        const next = Math.max(
            0,
            Math.min(100, Math.round(current + opts.brightnessDelta)),
        );
        resolved = { ...opts, brightness: next, brightnessDelta: undefined };
    }

    await applyGovee(g, resolved, goveeChannel.get(id) ?? 'rgb');
    const deltaOnly =
        opts.brightnessDelta !== undefined && opts.on === undefined;
    store.updateState(id, {
        ...(!deltaOnly && { on: opts.on !== false }),
        ...(resolved.brightness !== undefined && {
            brightness: resolved.brightness,
        }),
    });
}

// ── Shared light command paths ────────────────────────────────────────────────
// set_lights and light_set are two schemas over the same behaviour — they route
// here so Govee handling can never drift between them.

interface LightOpts {
    on?: boolean;
    brightness?: number;
    brightnessDelta?: number;
    color?: string;
    colorTempK?: number;
    transitionMs?: number;
}

/** Whole-flat on/off. Ambiance devices follow the off, never the on. */
async function applyAllLights(
    on: boolean,
    brightness?: number,
): Promise<string> {
    if (!on) {
        // Stop every ambiance loop first — a live loop re-lights its lamp.
        stopAllAmbiance();
    }
    const lights = store
        .getAll()
        .filter((l) => !on || !ambianceIds.has(String(l.id)));
    const hueIds = lights
        .filter((l) => !isGovee(l.id))
        .map((l) => Number(l.id));

    // Dedupe Govee by IP — several logical lights may share one device.
    const seenIps = new Set<string>();
    const goveeOps: Promise<void>[] = [];
    for (const l of goveeTargetsForAll(lights, ambianceIds, !on)) {
        const g = goveeById.get(String(l.id));
        if (!g || seenIps.has(g.ip)) continue;
        seenIps.add(g.ip);
        goveeOps.push(
            applyGoveeById(String(l.id), { on, brightness }).catch(() => {}),
        );
    }
    await Promise.all([
        hue.setAllLightsState(hueIds, on, on ? brightness : undefined),
        ...goveeOps,
    ]);
    lights.forEach((l) =>
        store.updateState(l.id, {
            on,
            ...(on && brightness !== undefined && { brightness }),
        }),
    );
    return on
        ? `All ${lights.length} lights turned on${
              brightness !== undefined ? ` at brightness ${brightness}` : ''
          }.`
        : `All ${lights.length} lights turned off.`;
}

/** Room name or individual light name. */
async function applyLightTarget(
    target: string,
    opts: LightOpts,
): Promise<string> {
    const { on, brightness, brightnessDelta, color, colorTempK, transitionMs } =
        opts;
    const turningOff = on === false;

    // Try room first
    try {
        const msg = await hue.setRoomLights(target, {
            on,
            brightness,
            brightnessDelta,
            color,
            colorTempK,
            transitionMs,
        });
        // Then the Govee devices anchored to that room. Ambiance ones are only
        // in this list when the room is being switched off.
        for (const gl of goveeTargetsForRoom(
            store.getAll(),
            target,
            ambianceIds,
            turningOff,
        )) {
            await applyGoveeById(String(gl.id), {
                on,
                brightness,
                brightnessDelta,
                color,
                colorTempK,
            }).catch(() => {});
        }
        return msg;
    } catch {
        // Not a room — try an individual light by name
    }

    const lights = store.getAll();
    const lc = target.toLowerCase().trim();
    const light =
        lights.find((l) => l.name.toLowerCase() === lc) ??
        lights.find(
            (l) =>
                l.name.toLowerCase().includes(lc) ||
                lc.includes(l.name.toLowerCase()),
        );

    if (!light) {
        const rooms = hue.getRoomNames().join(', ');
        const names = lights.map((l) => l.name).join(', ');
        throw new Error(
            `"${target}" introuvable. Pièces : ${rooms}. Lampes : ${names}`,
        );
    }

    if (isGovee(light.id)) {
        // Explicit by-name control — the only way an ambiance device lights up.
        stopAmbianceOnLamp(goveeById.get(String(light.id))!.ip);
        await applyGoveeById(String(light.id), {
            on,
            brightness,
            brightnessDelta,
            color,
            colorTempK,
        });
    } else {
        const lightId = Number(light.id);
        if (turningOff) {
            await hue.setLightState(lightId, false);
            store.updateState(lightId, { on: false });
        } else {
            const ops: Promise<void>[] = [];
            if (brightnessDelta !== undefined)
                ops.push(hue.incLightBrightness(lightId, brightnessDelta));
            else if (brightness !== undefined)
                ops.push(hue.setLightBrightness(lightId, brightness));
            if (colorTempK !== undefined)
                ops.push(
                    hue.setLightColorTemp(lightId, colorTempK, transitionMs),
                );
            else if (color !== undefined)
                ops.push(hue.setLightColor(lightId, color, transitionMs));
            if (ops.length === 0) ops.push(hue.setLightState(lightId, true));
            await Promise.all(ops);
            // Delta : l'état exact revient par le flux SSE du bridge.
            if (brightnessDelta === undefined) {
                store.updateState(lightId, {
                    on: true,
                    ...(brightness !== undefined && { brightness }),
                });
            }
        }
    }

    const parts: string[] = [];
    if (turningOff) parts.push('éteint');
    else {
        if (brightnessDelta !== undefined)
            parts.push(
                `luminosité ${
                    brightnessDelta > 0 ? '+' : ''
                }${brightnessDelta}%`,
            );
        else if (brightness !== undefined)
            parts.push(`luminosité ${brightness}%`);
        else parts.push('allumé');
        if (colorTempK !== undefined) parts.push(`blanc ${colorTempK}K`);
        else if (color) parts.push(`couleur ${color}`);
    }
    return `${light.name} : ${parts.join(', ')}`;
}

const server = new Server(
    { name: 'mcp-hue', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: HUE_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'set_lights': {
                const a = args as any;
                const msg = await applyLightTarget(String(a.target), {
                    on: a.on !== undefined ? Boolean(a.on) : undefined,
                    brightness:
                        a.brightness !== undefined
                            ? Number(a.brightness)
                            : undefined,
                    brightnessDelta:
                        a.brightnessDelta !== undefined
                            ? Number(a.brightnessDelta)
                            : undefined,
                    color: a.color !== undefined ? String(a.color) : undefined,
                    colorTempK:
                        a.colorTemp !== undefined
                            ? Number(a.colorTemp)
                            : undefined,
                    transitionMs:
                        a.transitionMs !== undefined
                            ? Number(a.transitionMs)
                            : undefined,
                });
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'turn_on_light':
            case 'turn_off_light': {
                const on = name === 'turn_on_light';
                const id = lightIdArg((args as any).lightId);
                if (typeof id === 'string') {
                    await applyGoveeById(id, { on });
                } else {
                    await hue.setLightState(id, on);
                    store.updateState(id, { on });
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Light ${id} turned ${on ? 'on' : 'off'}.`,
                        },
                    ],
                };
            }

            case 'set_brightness': {
                const id = lightIdArg((args as any).lightId);
                const brightness = Number((args as any).brightness);
                if (typeof id === 'string') {
                    await applyGoveeById(id, { brightness });
                } else {
                    await hue.setLightBrightness(id, brightness);
                    store.updateState(id, { brightness });
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Light ${id} brightness set to ${brightness}%.`,
                        },
                    ],
                };
            }

            case 'set_color': {
                const id = lightIdArg((args as any).lightId);
                const color = String((args as any).color);
                if (typeof id === 'string') {
                    await applyGoveeById(id, { color });
                } else {
                    await hue.setLightColor(id, color);
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Light ${id} color set to ${color}.`,
                        },
                    ],
                };
            }

            case 'set_lights_bulk': {
                const entries = ((args as any).states ?? []) as BulkEntry[];
                if (!entries.length) {
                    throw new Error('states: au moins une entrée requise.');
                }
                const othersOff = (args as any).othersOff === true;

                // 1. L'extinction du reste d'abord : la scène « apparaît »
                //    plutôt que de s'éteindre autour de ce qui vient de
                //    s'allumer.
                if (othersOff) {
                    const all = store.getAll();
                    const covered = coveredIds(all, entries);
                    const goveeIps = new Map(
                        [...goveeById].map(([id, g]) => [id, g.ip]),
                    );
                    const { hueIds, goveeIds } = othersToTurnOff(
                        all,
                        covered,
                        goveeIps,
                    );
                    await Promise.all([
                        hueIds.length
                            ? hue.setAllLightsState(hueIds, false)
                            : Promise.resolve(),
                        ...goveeIds.map((id) =>
                            applyGoveeById(id, { on: false }).catch(() => {}),
                        ),
                    ]);
                    hueIds.forEach((id) =>
                        store.updateState(id, { on: false }),
                    );
                }

                // 2. Puis chaque cible, dans l'ordre donné.
                const results: string[] = [];
                for (const e of entries) {
                    results.push(
                        await applyLightTarget(String(e.target), {
                            on: e.on,
                            brightness:
                                e.brightness !== undefined
                                    ? Number(e.brightness)
                                    : undefined,
                            color:
                                e.color !== undefined
                                    ? String(e.color)
                                    : undefined,
                            colorTempK:
                                e.colorTemp !== undefined
                                    ? Number(e.colorTemp)
                                    : undefined,
                        }),
                    );
                }
                if (othersOff) results.push('reste éteint');
                return {
                    content: [{ type: 'text', text: results.join(' · ') }],
                };
            }

            case 'set_room_palette': {
                const room = String((args as any).room);
                const colors = (args as any).colors as string[];
                const brightness =
                    (args as any).brightness !== undefined
                        ? Number((args as any).brightness)
                        : undefined;
                const transitionMs =
                    (args as any).transitionMs !== undefined
                        ? Number((args as any).transitionMs)
                        : undefined;
                const msg = await hue.setRoomPalette(
                    room,
                    colors,
                    brightness,
                    transitionMs,
                );
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'list_lights': {
                await refreshHueState((args as any)?.refresh === true);
                const lights = store
                    .getAll()
                    .filter((l) => !ambianceIds.has(String(l.id)));
                return {
                    content: [
                        { type: 'text', text: JSON.stringify(lights, null, 2) },
                    ],
                };
            }

            case 'turn_off_all_lights': {
                const msg = await applyAllLights(false);
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'turn_on_all_lights': {
                const brightness =
                    (args as any)?.brightness !== undefined
                        ? Number((args as any).brightness)
                        : undefined;
                const msg = await applyAllLights(true, brightness);
                return { content: [{ type: 'text', text: msg }] };
            }

            case 'refresh_lights': {
                await refreshHueState(true);
                const lights = store.getAll();
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Lights refreshed. ${lights.length} lights discovered.`,
                        },
                    ],
                };
            }

            case 'govee_ambiance_start': {
                const targetName = String((args as any).device);
                const presetId = String((args as any).preset);
                const lights = store.getAll().filter((l) => isGovee(l.id));
                const lc = targetName.toLowerCase().trim();
                const light =
                    lights.find((l) => l.name.toLowerCase() === lc) ??
                    lights.find((l) => l.name.toLowerCase().includes(lc));
                if (!light) {
                    throw new Error(
                        `Govee device "${targetName}" introuvable. Dispos : ${lights
                            .map((l) => l.name)
                            .join(', ')}`,
                    );
                }
                const g = goveeById.get(String(light.id));
                if (!g) throw new Error('Govee client not registered');
                const preset = startAmbiance(String(light.id), presetId, g);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Ambiance "${preset.name}" lancée sur ${light.name}.`,
                        },
                    ],
                };
            }

            case 'govee_ambiance_stop': {
                const targetName = String((args as any).device);
                const lights = store.getAll().filter((l) => isGovee(l.id));
                const lc = targetName.toLowerCase().trim();
                const light =
                    lights.find((l) => l.name.toLowerCase() === lc) ??
                    lights.find((l) => l.name.toLowerCase().includes(lc));
                if (!light)
                    throw new Error(
                        `Govee device "${targetName}" introuvable.`,
                    );
                const stopped = stopAmbiance(String(light.id));
                return {
                    content: [
                        {
                            type: 'text',
                            text: stopped
                                ? `Ambiance arrêtée sur ${light.name}.`
                                : `Aucune ambiance active sur ${light.name}.`,
                        },
                    ],
                };
            }

            case 'govee_ambiance_list': {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(listAmbiance(), null, 2),
                        },
                    ],
                };
            }

            default:
                throw new McpError(
                    ErrorCode.MethodNotFound,
                    `Unknown tool: ${name}`,
                );
        }
    } catch (error) {
        if (error instanceof McpError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        Logger.error(`Tool ${name} failed: ${message}`);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

interface GoveeDeviceConfig {
    ip: string;
    name: string;
    room?: string;
    // 'light': integrated as any other lamp (in list_lights, room hooks, all-on/off).
    // 'ambiance': hidden from list_lights + all-on. Still affected by all-off.
    mode?: 'light' | 'ambiance';
    // 'rgb' (default): colorwc with RGB → all currently-active RGB zones.
    // 'cct': colorwc with kelvin → the white CCT bulb (e.g. H60B0 lower).
    channel?: 'cct' | 'rgb';
}

const ambianceIds = new Set<string>();

function loadGoveeDevices(): GoveeDeviceConfig[] {
    // Multi-device JSON form takes precedence.
    const json = process.env.GOVEE_DEVICES;
    if (json) {
        try {
            const arr = JSON.parse(json);
            if (Array.isArray(arr)) return arr;
        } catch (e) {
            Logger.warn(`GOVEE_DEVICES parse failed: ${e}`);
        }
    }
    // Single-device fallback.
    const ip = process.env.GOVEE_IP;
    if (!ip) return [];
    return [
        {
            ip,
            name: process.env.GOVEE_NAME ?? 'Govee',
            room: process.env.GOVEE_ROOM,
            mode: process.env.GOVEE_MODE === 'ambiance' ? 'ambiance' : 'light',
            channel: process.env.GOVEE_CHANNEL === 'cct' ? 'cct' : 'rgb',
        },
    ];
}

function registerGoveeDevices(): void {
    const devices = loadGoveeDevices();
    if (!devices.length) return;
    const now = new Date().toISOString();
    const existing = store.getAll();
    const goveeEntities: LightEntity[] = devices.map((dev, i) => {
        const id = `g:${i + 1}`;
        goveeById.set(id, new GoveeClient(dev.ip, dev.name));
        goveeChannel.set(id, dev.channel ?? 'rgb');
        if (dev.mode === 'ambiance') ambianceIds.add(id);
        Logger.info(
            `[govee] registered "${dev.name}" @ ${dev.ip}${
                dev.room ? ` (${dev.room})` : ''
            } as ${id} [${dev.mode ?? 'light'}/${dev.channel ?? 'rgb'}]`,
        );
        return {
            type: 'light' as const,
            id,
            name: dev.name,
            room: dev.room,
            lastDiscovered: now,
            state: { on: false, brightness: 0, reachable: true },
        };
    });
    store.setAll([...existing, ...goveeEntities]);
    store.saveSnapshot();
}

async function main() {
    Logger.info('Connecting to Hue bridge...');
    const api = await HueBridge.connect();
    hue = new HueController(api);
    Logger.info(
        'Hue bridge connected. Initialising room cache and discovering lights...',
    );

    await hue.initCache();
    await discoverLights(hue, store);
    registerGoveeDevices();
    // Ambiance devices ARE in the target list: naming one explicitly is the
    // only way to light it (scenes, bindings), so the picker must offer it.
    const all = store.getAll();
    const lightNames = all.map((l) => l.name);
    const goveeNames = all.filter((l) => isGovee(l.id)).map((l) => l.name);
    HUE_TOOLS = buildHueTools(hue.getRoomNames(), lightNames, goveeNames);
    Logger.info(`Tools built with rooms: ${hue.getRoomNames().join(', ')}`);
    Logger.info(`Tools built with lights: ${lightNames.join(', ')}`);

    // Abonnement au flux d'état du bridge — après la découverte initiale, pour
    // que le mapping v2 → v1 porte sur des lampes déjà connues du store.
    await startEventStream();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-hue server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-hue:', err);
    process.exit(1);
});
