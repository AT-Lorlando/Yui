import https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import Logger from '../logger';
import { dataPath } from '@yui/shared';
import { hueRequest } from './animation/hueV2';
import { evaluateSceneCondition } from './scenes';
import type { SceneCondition } from './scenes';
import { createStateReader } from './deviceConditions';
import { migrateLegacyActions } from './legacyActions';
import type { PresenceState } from './presence';

/**
 * Hue v2 SSE watcher — dispatches remote button/dial events to scenes & tools.
 *
 * Config: data/hue-remotes.json
 *   {
 *     "<device name as exposed by bridge>": {
 *       "buttons": {
 *         "<control_id>:<event>": { "scene": "<id>" }
 *                              | { "tool": "<name>", "args": {...} }
 *       },
 *       "dial": { "room": "<room name>", "stepFactor": 0.3 }
 *     }
 *   }
 *
 * Dial uses Hue v2 native `dimming_delta` on the room's grouped_light, so no
 * MCP roundtrip and the bridge handles concurrent rotation events smoothly.
 */

interface ButtonResource {
    id: string;
    owner: { rid: string; rtype: string };
    metadata?: { control_id?: number };
}

interface DeviceResource {
    id: string;
    metadata?: { name?: string };
    product_data?: { product_name?: string };
}

interface RoomResource {
    id: string;
    metadata?: { name?: string };
    services?: Array<{ rid: string; rtype: string }>;
}

interface HueEvent {
    type: string;
    data: Array<{
        id: string;
        type: string;
        button?: { last_event?: string; button_report?: { event?: string } };
        relative_rotary?: {
            last_event?: {
                action?: string;
                rotation?: { direction?: string; steps?: number };
            };
            rotary_report?: {
                action?: string;
                rotation?: { direction?: string; steps?: number };
            };
        };
    }>;
}

interface ButtonInfo {
    deviceName: string;
    controlId: number;
}
interface RotaryInfo {
    deviceName: string;
}

// One step of a binding sequence — identical shape to a SceneAction.
export interface RemoteAction {
    tool: string;
    args?: Record<string, unknown>;
    delayMs?: number;
    /**
     * Même condition que dans une scène. Évaluée sur l'état lu **au début de
     * l'appui** : deux actions opposées sur le même bouton ("éteins si allumé",
     * "allume si éteint") se comportent donc comme une bascule, la première
     * n'influençant pas la condition de la seconde.
     */
    condition?: SceneCondition;
}

export interface ButtonConfig {
    // shortPress[N] = sequence to run on the N-th consecutive short press
    // (1 = single click, 2 = double, …). Detection uses a debounce window.
    shortPress?: Record<string, RemoteAction[]>;
    longPress?: RemoteAction[];
    longRelease?: RemoteAction[];
}

export interface DeviceConfig {
    buttons?: Record<string, ButtonConfig>;
    dial?: {
        room: string;
        stepFactor?: number;
        /** Si la musique joue, la molette règle le volume Spotify au lieu des lumières. */
        musicVolume?: boolean;
        /** % de volume par cran (steps × facteur). Défaut 0.12. */
        volumeStepFactor?: number;
    };
}

export type RemotesConfig = Record<string, DeviceConfig>;

export interface RemoteDeviceInfo {
    name: string;
    productName: string;
    buttonCount: number;
    hasDial: boolean;
}

export interface RemotesSnapshot {
    devices: RemoteDeviceInfo[];
    rooms: string[];
    config: RemotesConfig;
}

export interface HueRemotesDeps {
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    /** Pour les conditions de présence des bindings. */
    presenceState?: () => PresenceState;
}

const CONFIG_PATH = dataPath('hue-remotes.json');

const buttons = new Map<string, ButtonInfo>();
const rotaries = new Map<string, RotaryInfo>();
const roomGroupId = new Map<string, string>(); // room name (lc) → grouped_light uuid
const roomNames: string[] = []; // preserved with original casing
const deviceCatalog = new Map<string, RemoteDeviceInfo>();
let config: RemotesConfig = {};
let stopRequested = false;
let currentReq: ReturnType<typeof https.request> | null = null;
let bridgeHost: string | undefined;
let bridgeKey: string | undefined;

function loadConfig(): void {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            config = {};
            return;
        }
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        // Bindings enregistrés avec d'anciens noms d'actions → canoniques.
        for (const dev of Object.values(config)) {
            for (const btn of Object.values(dev.buttons ?? {})) {
                if (btn.shortPress) {
                    for (const [k, seq] of Object.entries(btn.shortPress)) {
                        btn.shortPress[k] = migrateLegacyActions(seq);
                    }
                }
                if (btn.longPress)
                    btn.longPress = migrateLegacyActions(btn.longPress);
                if (btn.longRelease)
                    btn.longRelease = migrateLegacyActions(btn.longRelease);
            }
        }
        Logger.info(
            `[hue-remotes] config loaded: ${
                Object.keys(config).length
            } device(s)`,
        );
    } catch (e) {
        Logger.warn(`[hue-remotes] failed to load config: ${e}`);
        config = {};
    }
}

async function buildResourceMaps(host: string, key: string): Promise<void> {
    const [buttonsResp, rotariesResp, devicesResp, roomsResp] =
        await Promise.all([
            hueRequest(host, key, '/clip/v2/resource/button'),
            hueRequest(host, key, '/clip/v2/resource/relative_rotary').catch(
                () => ({ data: [] }),
            ),
            hueRequest(host, key, '/clip/v2/resource/device'),
            hueRequest(host, key, '/clip/v2/resource/room'),
        ]);

    const devs = new Map<string, DeviceResource>();
    for (const d of (devicesResp.data ?? []) as DeviceResource[]) {
        devs.set(d.id, d);
    }
    buttons.clear();
    for (const b of (buttonsResp.data ?? []) as ButtonResource[]) {
        const dev = devs.get(b.owner.rid);
        buttons.set(b.id, {
            deviceName: dev?.metadata?.name ?? 'unknown',
            controlId: b.metadata?.control_id ?? 0,
        });
    }
    rotaries.clear();
    for (const r of (rotariesResp.data ?? []) as ButtonResource[]) {
        const dev = devs.get(r.owner.rid);
        rotaries.set(r.id, { deviceName: dev?.metadata?.name ?? 'unknown' });
    }
    roomGroupId.clear();
    roomNames.length = 0;
    for (const r of (roomsResp.data ?? []) as RoomResource[]) {
        const grouped = r.services?.find((s) => s.rtype === 'grouped_light');
        if (grouped && r.metadata?.name) {
            roomGroupId.set(r.metadata.name.toLowerCase(), grouped.rid);
            roomNames.push(r.metadata.name);
        }
    }

    // Build device catalog: aggregate buttons + dial presence per device.
    deviceCatalog.clear();
    for (const info of buttons.values()) {
        const existing = deviceCatalog.get(info.deviceName);
        if (existing) {
            existing.buttonCount = Math.max(
                existing.buttonCount,
                info.controlId,
            );
        } else {
            const dev = [...devs.values()].find(
                (d) => d.metadata?.name === info.deviceName,
            );
            deviceCatalog.set(info.deviceName, {
                name: info.deviceName,
                productName: dev?.product_data?.product_name ?? 'unknown',
                buttonCount: info.controlId,
                hasDial: false,
            });
        }
    }
    for (const info of rotaries.values()) {
        const existing = deviceCatalog.get(info.deviceName);
        if (existing) {
            existing.hasDial = true;
        } else {
            deviceCatalog.set(info.deviceName, {
                name: info.deviceName,
                productName: 'unknown',
                buttonCount: 0,
                hasDial: true,
            });
        }
    }

    Logger.info(
        `[hue-remotes] resources: ${buttons.size} buttons, ${rotaries.size} rotaries, ${roomGroupId.size} rooms, ${deviceCatalog.size} devices`,
    );
}

async function setRoomDimmingDelta(
    room: string,
    action: 'up' | 'down',
    delta: number,
): Promise<void> {
    if (!bridgeHost || !bridgeKey) return;
    const groupId = roomGroupId.get(room.toLowerCase());
    if (!groupId) {
        Logger.warn(`[hue-remotes] room "${room}" not found for brightness`);
        return;
    }
    await hueRequest(
        bridgeHost,
        bridgeKey,
        `/clip/v2/resource/grouped_light/${groupId}`,
        'PUT',
        { dimming_delta: { action, brightness_delta: Math.abs(delta) } },
    );
}

async function setRoomDimming(room: string, value: number): Promise<void> {
    if (!bridgeHost || !bridgeKey) return;
    const groupId = roomGroupId.get(room.toLowerCase());
    if (!groupId) {
        Logger.warn(`[hue-remotes] room "${room}" not found for brightness`);
        return;
    }
    const clamped = Math.min(100, Math.max(0, value));
    const on = clamped > 0;
    await hueRequest(
        bridgeHost,
        bridgeKey,
        `/clip/v2/resource/grouped_light/${groupId}`,
        'PUT',
        { on: { on }, ...(on && { dimming: { brightness: clamped } }) },
    );
}

const MULTI_PRESS_WINDOW_MS = 400;

/**
 * Fenêtre de debounce d'un bouton. La fenêtre n'a de raison d'être que si le
 * bouton a des bindings multi-appui (2×, 3×…) : sinon attendre 400 ms avant
 * chaque action ne fait qu'ajouter de la latence perceptible.
 */
export function multiPressWindow(btnCfg?: ButtonConfig): number {
    const counts = Object.keys(btnCfg?.shortPress ?? {});
    return counts.some((k) => Number(k) > 1) ? MULTI_PRESS_WINDOW_MS : 0;
}

interface PressBuffer {
    count: number;
    timer: NodeJS.Timeout;
}
const pressBuffers = new Map<string, PressBuffer>(); // key: device|btn

/** Exporté pour les tests — exécute une séquence de binding. */
export async function runActions(
    actions: RemoteAction[],
    deps: HueRemotesDeps,
): Promise<void> {
    // Un lecteur d'état par appui : chaque sujet n'est lu qu'une fois et toutes
    // les actions de la séquence voient le même instantané.
    const context = {
        presenceState: deps.presenceState?.(),
        stateReader: createStateReader((t, a) => deps.callTool(t, a ?? {})),
    };
    for (const a of actions) {
        if (a.delayMs && a.delayMs > 0) {
            await new Promise((r) => setTimeout(r, a.delayMs));
        }
        try {
            if (a.condition) {
                const pass = await evaluateSceneCondition(
                    a.condition,
                    context,
                    (t, args) => deps.callTool(t, args ?? {}),
                );
                if (!pass) {
                    Logger.info(
                        `[hue-remotes] ${
                            a.tool
                        } ignoré — condition ${JSON.stringify(
                            a.condition,
                        )} fausse`,
                    );
                    continue;
                }
            }
            await deps.callTool(a.tool, a.args ?? {});
        } catch (e) {
            Logger.warn(`[hue-remotes] tool ${a.tool} failed: ${e}`);
        }
    }
}

function dispatchShortPress(
    deviceName: string,
    controlId: number,
    deps: HueRemotesDeps,
): void {
    const key = `${deviceName}|${controlId}`;
    const btnCfg = config[deviceName]?.buttons?.[String(controlId)];

    // Pas de binding multi-appui → déclenchement immédiat, zéro latence.
    if (multiPressWindow(btnCfg) === 0) {
        pressBuffers.set(key, {
            count: 1,
            timer: setTimeout(() => {}, 0),
        });
        fireShortPress(deviceName, controlId, deps);
        return;
    }

    const existing = pressBuffers.get(key);

    if (existing) {
        existing.count++;
        clearTimeout(existing.timer);
        existing.timer = setTimeout(
            () => fireShortPress(deviceName, controlId, deps),
            MULTI_PRESS_WINDOW_MS,
        );
        return;
    }

    pressBuffers.set(key, {
        count: 1,
        timer: setTimeout(
            () => fireShortPress(deviceName, controlId, deps),
            MULTI_PRESS_WINDOW_MS,
        ),
    });
}

function fireShortPress(
    deviceName: string,
    controlId: number,
    deps: HueRemotesDeps,
): void {
    const key = `${deviceName}|${controlId}`;
    const buf = pressBuffers.get(key);
    if (!buf) return;
    const count = buf.count;
    pressBuffers.delete(key);

    const btnCfg = config[deviceName]?.buttons?.[String(controlId)];
    const seq = btnCfg?.shortPress?.[String(count)];
    if (!seq?.length) {
        Logger.info(
            `[hue-remotes] ${deviceName} btn${controlId} ${count}× (no binding)`,
        );
        return;
    }
    Logger.info(
        `[hue-remotes] ${deviceName} btn${controlId} ${count}× → ${seq.length} action(s)`,
    );
    void runActions(seq, deps);
}

function dispatchHoldEvent(
    deviceName: string,
    controlId: number,
    field: 'longPress' | 'longRelease',
    deps: HueRemotesDeps,
): void {
    const seq = config[deviceName]?.buttons?.[String(controlId)]?.[field];
    if (!seq?.length) return;
    Logger.info(
        `[hue-remotes] ${deviceName} btn${controlId} ${field} → ${seq.length} action(s)`,
    );
    void runActions(seq, deps);
}

/** Delta de volume signé pour un cran de molette. Pur (testé). */
export function dialVolumeDelta(
    direction: string,
    steps: number,
    factor = 0.12,
): number {
    const magnitude = Math.max(1, Math.round(steps * factor));
    return direction === 'clock_wise' ? magnitude : -magnitude;
}

// La molette émet un flot d'événements pendant la rotation : l'état "musique
// en cours" est mis en cache quelques secondes (une lecture par rotation, pas
// par cran), et les crans de volume sont accumulés puis appliqués en un seul
// set_volume — l'API Spotify n'aimerait pas un appel par cran.
const MUSIC_CACHE_MS = 2_500;
const VOLUME_FLUSH_MS = 250;
let musicCache: { ts: number; playing: boolean } = { ts: 0, playing: false };
let volumePending = 0;
let volumeTimer: NodeJS.Timeout | null = null;

async function isMusicPlaying(deps: HueRemotesDeps): Promise<boolean> {
    if (Date.now() - musicCache.ts < MUSIC_CACHE_MS) return musicCache.playing;
    try {
        const st = (await deps.callTool('get_playback_state', {})) as {
            playing?: boolean;
        };
        musicCache = { ts: Date.now(), playing: st?.playing === true };
    } catch {
        musicCache = { ts: Date.now(), playing: false };
    }
    return musicCache.playing;
}

function queueVolumeDelta(delta: number, deps: HueRemotesDeps): void {
    volumePending += delta;
    if (volumeTimer) clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => {
        volumeTimer = null;
        const pending = volumePending;
        volumePending = 0;
        void (async () => {
            try {
                const st = (await deps.callTool('get_playback_state', {})) as {
                    device?: { volume?: number };
                };
                const current = Number(st?.device?.volume ?? 50);
                const target = Math.max(
                    0,
                    Math.min(100, Math.round(current + pending)),
                );
                await deps.callTool('set_volume', { percent: target });
                Logger.info(
                    `[hue-remotes] dial volume ${current}% → ${target}%`,
                );
            } catch (e) {
                Logger.warn(`[hue-remotes] dial volume failed: ${e}`);
            }
        })();
    }, VOLUME_FLUSH_MS);
}

async function dispatchDial(
    deviceName: string,
    direction: string,
    steps: number,
    deps: HueRemotesDeps,
): Promise<void> {
    const dial = config[deviceName]?.dial;
    if (!dial) return;

    // Contextuel : musique en lecture → la molette devient le volume.
    if (dial.musicVolume && (await isMusicPlaying(deps))) {
        queueVolumeDelta(
            dialVolumeDelta(direction, steps, dial.volumeStepFactor),
            deps,
        );
        return;
    }

    const factor = dial.stepFactor ?? 0.3;
    const delta = Math.min(100, Math.max(1, Math.round(steps * factor)));
    const action = direction === 'clock_wise' ? 'up' : 'down';
    try {
        await setRoomDimmingDelta(dial.room, action, delta);
    } catch (e) {
        Logger.warn(`[hue-remotes] dial PUT failed: ${e}`);
    }
}

function handleSseChunk(buffer: string, deps: HueRemotesDeps): string {
    const parts = buffer.split('\n\n');
    const remainder = parts.pop() ?? '';
    for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
            const events = JSON.parse(dataLine.slice(6)) as HueEvent[];
            for (const ev of events) {
                if (ev.type !== 'update') continue;
                for (const item of ev.data ?? []) {
                    if (item.type === 'button') {
                        const info = buttons.get(item.id);
                        if (!info) continue;
                        const action =
                            item.button?.button_report?.event ??
                            item.button?.last_event;
                        if (!action) continue;
                        if (action === 'short_release') {
                            dispatchShortPress(
                                info.deviceName,
                                info.controlId,
                                deps,
                            );
                        } else if (action === 'long_press') {
                            dispatchHoldEvent(
                                info.deviceName,
                                info.controlId,
                                'longPress',
                                deps,
                            );
                        } else if (action === 'long_release') {
                            dispatchHoldEvent(
                                info.deviceName,
                                info.controlId,
                                'longRelease',
                                deps,
                            );
                        }
                    } else if (item.type === 'relative_rotary') {
                        const info = rotaries.get(item.id);
                        if (!info) continue;
                        const rep =
                            item.relative_rotary?.rotary_report ??
                            item.relative_rotary?.last_event;
                        const dir = rep?.rotation?.direction;
                        const steps = rep?.rotation?.steps ?? 0;
                        if (!dir || steps <= 0) continue;
                        void dispatchDial(info.deviceName, dir, steps, deps);
                    }
                }
            }
        } catch (e) {
            Logger.warn(`[hue-remotes] failed to parse SSE: ${e}`);
        }
    }
    return remainder;
}

function openStream(deps: HueRemotesDeps): void {
    if (stopRequested || !bridgeHost || !bridgeKey) return;
    const req = https.request(
        {
            host: bridgeHost,
            path: '/eventstream/clip/v2',
            method: 'GET',
            rejectUnauthorized: false,
            headers: {
                'hue-application-key': bridgeKey,
                Accept: 'text/event-stream',
            },
        },
        (res) => {
            if (res.statusCode !== 200) {
                Logger.warn(
                    `[hue-remotes] SSE returned HTTP ${res.statusCode}, retrying in 10s`,
                );
                res.resume();
                setTimeout(() => openStream(deps), 10_000);
                return;
            }
            Logger.info('[hue-remotes] SSE stream connected');
            let buffer = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                buffer += chunk;
                buffer = handleSseChunk(buffer, deps);
            });
            res.on('end', () => {
                Logger.warn(
                    '[hue-remotes] SSE stream ended, reconnecting in 5s',
                );
                if (!stopRequested) setTimeout(() => openStream(deps), 5_000);
            });
        },
    );
    req.on('error', (err) => {
        Logger.warn(`[hue-remotes] SSE error: ${err.message}, retrying in 10s`);
        if (!stopRequested) setTimeout(() => openStream(deps), 10_000);
    });
    req.end();
    currentReq = req;
}

function watchConfig(): fs.FSWatcher | null {
    try {
        return fs.watch(CONFIG_PATH, { persistent: false }, () => {
            setTimeout(loadConfig, 200); // debounce vs editor write
        });
    } catch {
        return null;
    }
}

export function getRemotesSnapshot(): RemotesSnapshot {
    return {
        devices: [...deviceCatalog.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
        ),
        rooms: [...roomNames].sort(),
        config,
    };
}

function cleanActionList(raw: any): RemoteAction[] {
    if (!Array.isArray(raw)) return [];
    const out: RemoteAction[] = [];
    for (const a of raw) {
        if (
            !a ||
            typeof a !== 'object' ||
            typeof a.tool !== 'string' ||
            !a.tool
        ) {
            continue;
        }
        const cleaned: RemoteAction = { tool: a.tool };
        if (a.args && typeof a.args === 'object') cleaned.args = a.args;
        if (typeof a.delayMs === 'number' && a.delayMs > 0) {
            cleaned.delayMs = Math.round(a.delayMs);
        }
        // La condition est éditable dans l'app : sans ce passage explicite,
        // elle était supprimée à l'enregistrement (whitelist de champs).
        if (a.condition && typeof a.condition === 'object') {
            cleaned.condition = a.condition as SceneCondition;
        }
        out.push(cleaned);
    }
    return out;
}

function cleanButton(raw: any): ButtonConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    const out: ButtonConfig = {};
    if (raw.shortPress && typeof raw.shortPress === 'object') {
        const sp: Record<string, RemoteAction[]> = {};
        for (const [count, list] of Object.entries(raw.shortPress)) {
            const n = Number(count);
            if (!Number.isInteger(n) || n < 1 || n > 9) continue;
            const cleaned = cleanActionList(list);
            if (cleaned.length) sp[String(n)] = cleaned;
        }
        if (Object.keys(sp).length) out.shortPress = sp;
    }
    const lp = cleanActionList(raw.longPress);
    if (lp.length) out.longPress = lp;
    const lr = cleanActionList(raw.longRelease);
    if (lr.length) out.longRelease = lr;
    return out.shortPress || out.longPress || out.longRelease ? out : null;
}

export function saveRemotesConfig(next: unknown): RemotesConfig {
    if (!next || typeof next !== 'object') {
        throw new Error('config must be an object');
    }
    const out: RemotesConfig = {};
    for (const [deviceName, raw] of Object.entries(
        next as Record<string, any>,
    )) {
        const dev: DeviceConfig = {};
        if (raw?.buttons && typeof raw.buttons === 'object') {
            const cleaned: Record<string, ButtonConfig> = {};
            for (const [k, v] of Object.entries(raw.buttons)) {
                const c = cleanButton(v);
                if (c) cleaned[k] = c;
            }
            if (Object.keys(cleaned).length > 0) dev.buttons = cleaned;
        }
        if (
            raw?.dial &&
            typeof raw.dial.room === 'string' &&
            raw.dial.room.trim()
        ) {
            dev.dial = {
                room: raw.dial.room,
                stepFactor:
                    typeof raw.dial.stepFactor === 'number'
                        ? Math.max(0.05, Math.min(2, raw.dial.stepFactor))
                        : 0.3,
                ...(raw.dial.musicVolume === true && { musicVolume: true }),
                ...(typeof raw.dial.volumeStepFactor === 'number' && {
                    volumeStepFactor: Math.max(
                        0.02,
                        Math.min(1, raw.dial.volumeStepFactor),
                    ),
                }),
            };
        }
        if (dev.buttons || dev.dial) out[deviceName] = dev;
    }
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + '\n');
    config = out;
    Logger.info(
        `[hue-remotes] config saved: ${Object.keys(out).length} device(s)`,
    );
    return out;
}

export async function initHueRemotes(
    deps: HueRemotesDeps,
): Promise<{ stop: () => void }> {
    const host = process.env.HUE_BRIDGE_IP;
    const key = process.env.HUE_USERNAME;
    if (!host || !key) {
        Logger.warn(
            '[hue-remotes] HUE_BRIDGE_IP or HUE_USERNAME missing — remotes disabled',
        );
        return { stop: () => {} };
    }

    bridgeHost = host;
    bridgeKey = key;
    loadConfig();
    const watcher = watchConfig();

    try {
        await buildResourceMaps(host, key);
    } catch (e) {
        Logger.warn(`[hue-remotes] failed to build resource maps: ${e}`);
    }
    openStream(deps);

    return {
        stop: () => {
            stopRequested = true;
            try {
                watcher?.close();
                currentReq?.destroy();
            } catch {
                // ignore
            }
        },
    };
}
