// Musique — « Mes playlists » (registre des favoris Spotify, liens collés
// compris) : CRUD sur data/config/spotify-playlists.json.
//
// ⚠️ Monté sur '/' : auth PAR ROUTE, jamais en `router.use` (cf. effects.ts).
import express from 'express';
import {
    deleteLinked,
    listLinked,
    reorderLinked,
    upsertLinked,
} from '../../orchestrator/musicPlaylists';
import type { RequireAuth } from './helpers';

export function musicRoutes(requireAuth: RequireAuth): express.Router {
    const r = express.Router();

    r.get('/music/playlists', requireAuth, (_req: any, res: any) => {
        res.json(listLinked());
    });

    r.post('/music/playlists', requireAuth, (req: any, res: any) => {
        try {
            res.json(upsertLinked(req.body ?? {}));
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    r.put('/music/playlists/order', requireAuth, (req: any, res: any) => {
        const ids = Array.isArray(req.body?.ids)
            ? req.body.ids.map(String)
            : null;
        if (!ids) return res.status(400).json({ error: 'ids requis' });
        res.json(reorderLinked(ids));
    });

    r.delete('/music/playlists/:id', requireAuth, (req: any, res: any) => {
        if (!deleteLinked(String(req.params.id))) {
            return res.status(404).json({ error: 'Playlist introuvable' });
        }
        res.json({ ok: true });
    });

    return r;
}
