// Présence (état, webhook geofence, config, règles) — monté sur /presence.
import express from 'express';
import Logger from '../../logger';
import type { PresenceHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

export function presenceRoutes(
    requireAuth: RequireAuth,
    presenceHandler?: PresenceHandler,
): express.Router {
    const r = express.Router();
    r.use(requireAuth);

    r.get('/', (_req: any, res: any) => {
        res.json({
            state: presenceHandler ? presenceHandler.getState() : 'unknown',
            config: presenceHandler ? presenceHandler.getConfig() : null,
        });
    });

    // Webhook du geofence natif Android (arrivée/départ).
    r.post('/geofence', (req: any, res: any) => {
        const transition = String(req.body?.transition ?? '');
        if (transition !== 'enter' && transition !== 'exit') {
            return res
                .status(400)
                .json({ error: "transition must be 'enter' or 'exit'" });
        }
        Logger.info(
            `[presence] geofence webhook reçu: ${transition} (ip=${req.ip})`,
        );
        if (!presenceHandler) {
            return res.status(503).json({ error: 'presence unavailable' });
        }
        const cfg = presenceHandler.getConfig();
        if (!cfg.geofence.enabled) {
            return res.json({
                state: presenceHandler.getState(),
                ignored: true,
            });
        }
        const state = presenceHandler.handleGeofence(transition);
        res.json({ state });
    });

    r.get('/config', (_req: any, res: any) => {
        res.json(presenceHandler ? presenceHandler.getConfig() : null);
    });

    r.put('/config', (req: any, res: any) => {
        if (!presenceHandler)
            return res.status(503).json({ error: 'presence unavailable' });
        const body = req.body ?? {};
        const patch: any = {};
        if (body.geofence) patch.geofence = body.geofence;
        if (body.mac) patch.mac = body.mac;
        res.json(presenceHandler.setConfig(patch));
    });

    r.get('/rules', (_req: any, res: any) => {
        res.json(presenceHandler ? presenceHandler.listRules() : []);
    });

    r.put('/rules', (req: any, res: any) => {
        if (!presenceHandler)
            return res.status(503).json({ error: 'presence unavailable' });
        try {
            res.json(presenceHandler.replaceRules(req.body));
        } catch (e: any) {
            res.status(400).json({ error: String(e?.message ?? e) });
        }
    });

    return r;
}
