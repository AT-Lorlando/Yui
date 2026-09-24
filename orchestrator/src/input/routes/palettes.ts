// Ambiances (palettes de pièce) — CRUD sur data/config/palettes.json.
//
// ⚠️ Monté sur '/' : auth PAR ROUTE, jamais en `router.use` (cf. effects.ts).
import express from 'express';
import {
    deletePalette,
    listPalettes,
    upsertPalette,
} from '../../orchestrator/palettes';
import type { RequireAuth } from './helpers';

export function paletteRoutes(requireAuth: RequireAuth): express.Router {
    const r = express.Router();

    r.get('/palettes', requireAuth, (_req: any, res: any) => {
        res.json(listPalettes());
    });

    r.post('/palettes', requireAuth, (req: any, res: any) => {
        try {
            res.json(upsertPalette(req.body ?? {}));
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    r.delete('/palettes/:id', requireAuth, (req: any, res: any) => {
        if (!deletePalette(String(req.params.id))) {
            return res.status(404).json({ error: 'Ambiance introuvable' });
        }
        res.json({ ok: true });
    });

    return r;
}
