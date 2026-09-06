// Divers : timers, presets, journal d'activité, colis, chime, token FCM.
// Monté sur '/' (chemins historiques) — auth PAR ROUTE ; /chime reste PUBLIC
// (appelé par mcp-timer sans Bearer — il était cassé par un middleware de
// router trop large, ne pas réintroduire).
import express from 'express';
import * as fs from 'fs';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import { readActivity } from '../../orchestrator/activityLog';
import {
    addManual as addParcel,
    listParcels,
    removeParcel,
} from '../../orchestrator/deliveries/tracker';
import {
    listPresets,
    addPreset,
    removePreset,
} from '../../orchestrator/timerPresets';
import { saveFcmToken } from '../../orchestrator/notify';
import type { DeviceHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

export function miscRoutes(
    requireAuth: RequireAuth,
    deviceHandler?: DeviceHandler,
): express.Router {
    const r = express.Router();

    // ── Timers (read from shared data file) ──────────────────────────
    r.get('/timers', requireAuth, (_req: any, res: any) => {
        try {
            const timersFile = dataPath('timers.json');
            const raw = fs.existsSync(timersFile)
                ? (JSON.parse(fs.readFileSync(timersFile, 'utf-8')) as {
                      id: string;
                      label: string;
                      duration_seconds: number;
                      started_at: number;
                      fires_at: number;
                      room?: string;
                  }[])
                : [];
            const now = Date.now();
            res.json(
                raw.map((t) => ({
                    ...t,
                    remaining_seconds: Math.max(
                        0,
                        Math.round((t.fires_at - now) / 1_000),
                    ),
                })),
            );
        } catch {
            res.json([]);
        }
    });

    r.get('/timer-presets', requireAuth, (_req: any, res: any) => {
        res.json(listPresets());
    });

    r.post('/timer-presets', requireAuth, (req: any, res: any) => {
        try {
            const preset = addPreset(req.body ?? {});
            res.status(201).json(preset);
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    r.delete('/timer-presets/:id', requireAuth, (req: any, res: any) => {
        const ok = removePreset(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Preset not found' });
        res.json({ success: true });
    });

    // ── Chime cast (called internally by mcp-timer, NO AUTH) ─────────
    // Receives { url } and casts the audio file to the default speaker.
    r.post('/chime', async (req: any, res: any) => {
        const { url } = req.body ?? {};
        if (!url || !deviceHandler) return res.json({ ok: false });
        try {
            await deviceHandler('cast_media', {
                content_id: url,
                content_type: 'audio/mpeg',
                title: 'Minuteur',
            });
            Logger.info(`Chime cast: ${url}`);
            return res.json({ ok: true });
        } catch (e: any) {
            Logger.error(`Chime cast failed: ${e.message}`);
            return res.status(500).json({ error: e.message });
        }
    });

    // ── Journal d'activité ───────────────────────────────────────────
    r.get('/activity', requireAuth, (req: any, res: any) => {
        const limit = Math.min(400, Number(req.query?.limit) || 120);
        res.json(readActivity(limit));
    });

    // ── Suivi de colis ───────────────────────────────────────────────
    r.get('/deliveries', requireAuth, (_req: any, res: any) => {
        res.json(listParcels());
    });

    r.post('/deliveries', requireAuth, async (req: any, res: any) => {
        const { tracking, carrier, label, url } = req.body ?? {};
        if (!tracking || typeof tracking !== 'string') {
            return res.status(400).json({ error: 'tracking requis' });
        }
        try {
            const parcel = await addParcel({ tracking, carrier, label, url });
            res.json(parcel);
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    r.delete('/deliveries/:id', requireAuth, (req: any, res: any) => {
        if (!removeParcel(String(req.params.id))) {
            return res.status(404).json({ error: 'Colis introuvable' });
        }
        res.json({ ok: true });
    });

    // ── FCM device token registration ────────────────────────────────
    r.post('/devices/fcm-token', requireAuth, (req: any, res: any) => {
        const { token } = req.body ?? {};
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: 'Missing token' });
        }
        saveFcmToken(token);
        return res.json({ ok: true });
    });

    return r;
}
