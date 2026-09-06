// Contrôle direct des appareils (bypasse le LLM) — monté sur /devices.
import express from 'express';
import type { DeviceHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

export function deviceRoutes(
    requireAuth: RequireAuth,
    deviceHandler: DeviceHandler,
): express.Router {
    const dev = express.Router();
    dev.use(requireAuth);

    const call =
        (tool: string, args: Record<string, unknown> = {}) =>
        async (_req: any, res: any) => {
            try {
                res.json(await deviceHandler(tool, args));
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        };

    /** Handler appelant `tool` avec des args dérivés de la requête. */
    const callWith =
        (tool: string, args: (req: any) => Record<string, unknown>) =>
        async (req: any, res: any) => {
            try {
                res.json(await deviceHandler(tool, args(req)));
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        };

    // ── Lights ────────────────────────────────────────────────────────
    dev.get('/lights', call('list_lights'));
    // Atomic "turn everything off" — also cancels any floating loop
    // (via callTool → cancelIfAffected), unlike N per-light requests.
    dev.post('/lights/off-all', call('turn_off_all_lights'));
    dev.post('/lights/on-all', call('turn_on_all_lights'));
    // Ids are numeric for Hue, strings ("g:1") for Govee — keep the
    // raw value when it isn't a plain number.
    const lightId = (raw: string): string | number =>
        /^\d+$/.test(raw) ? Number(raw) : raw;
    dev.post(
        '/lights/:id/on',
        callWith('turn_on_light', (req) => ({
            lightId: lightId(req.params.id),
        })),
    );
    dev.post(
        '/lights/:id/off',
        callWith('turn_off_light', (req) => ({
            lightId: lightId(req.params.id),
        })),
    );
    dev.patch(
        '/lights/:id/brightness',
        callWith('set_brightness', (req) => ({
            lightId: lightId(req.params.id),
            brightness: +req.body.brightness,
        })),
    );
    dev.patch(
        '/lights/:id/color',
        callWith('set_color', (req) => ({
            lightId: lightId(req.params.id),
            color: req.body.color,
        })),
    );

    // ── Rooms (grouped light control) ────────────────────────────────
    dev.post(
        '/rooms/:room/lights',
        callWith('set_lights', (req) => ({
            target: req.params.room,
            ...(req.body?.on !== undefined ? { on: !!req.body.on } : {}),
            ...(req.body?.brightness !== undefined
                ? { brightness: +req.body.brightness }
                : {}),
            ...(req.body?.colorTemp !== undefined
                ? { colorTemp: +req.body.colorTemp }
                : {}),
        })),
    );
    dev.post(
        '/rooms/:room/palette',
        callWith('set_room_palette', (req) => ({
            room: req.params.room,
            colors: req.body?.colors,
            ...(req.body?.brightness !== undefined
                ? { brightness: +req.body.brightness }
                : {}),
        })),
    );

    // ── Doors ─────────────────────────────────────────────────────────
    dev.get('/doors', call('list_doors'));
    dev.post(
        '/doors/:id/lock',
        callWith('lock_door', (req) => ({ nukiId: +req.params.id })),
    );
    dev.post(
        '/doors/:id/unlock',
        callWith('unlock_door', (req) => ({ nukiId: +req.params.id })),
    );

    // ── Spotify ───────────────────────────────────────────────────────
    dev.get('/spotify', call('get_playback_state'));
    dev.post('/spotify/play', call('play_music'));
    dev.post('/spotify/pause', call('pause_music'));
    dev.post('/spotify/next', call('next_track'));
    dev.post('/spotify/previous', call('previous_track'));
    dev.patch(
        '/spotify/volume',
        callWith('set_volume', (req) => ({ percent: +req.body.percent })),
    );

    // ── TV (mcp-smartthings : WoL + SmartThings cloud) ────────────────
    dev.get('/tv', call('tv_get_status'));
    dev.post('/tv/on', call('tv_on'));
    dev.post('/tv/off', call('tv_off'));
    dev.patch(
        '/tv/volume',
        callWith('tv_volume', (req) => ({ level: +req.body.level })),
    );
    dev.post('/tv/mute', call('tv_mute', { mute: true }));
    dev.post('/tv/unmute', call('tv_mute', { mute: false }));
    dev.post(
        '/tv/input',
        callWith('tv_set_input', (req) => ({ source: req.body.source })),
    );

    // ── Covers (Somfy) ────────────────────────────────────────────────
    dev.get('/covers', call('list_covers'));
    dev.post(
        '/covers/open',
        callWith('open_cover', (req) => ({ device: req.body.device })),
    );
    dev.post(
        '/covers/close',
        callWith('close_cover', (req) => ({ device: req.body.device })),
    );
    dev.patch(
        '/covers/position',
        callWith('set_cover_position', (req) => ({
            device: req.body.device,
            position: +req.body.position,
        })),
    );

    // ── Irrigation ────────────────────────────────────────────────────
    dev.get('/irrigation', call('irrigation_status'));
    dev.post(
        '/irrigation/start',
        callWith('irrigation_start', (req) => ({
            target: req.body.target,
            amount: req.body.amount,
        })),
    );
    dev.post(
        '/irrigation/stop',
        callWith('irrigation_stop', (req) => ({
            target: req.body?.target ?? 'all',
        })),
    );

    return dev;
}
