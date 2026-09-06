// Scènes — monté sur /scenes.
import express from 'express';
import type { ScenesHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

export function sceneRoutes(
    requireAuth: RequireAuth,
    scenesHandler: ScenesHandler,
): express.Router {
    const sc = express.Router();
    sc.use(requireAuth);

    sc.get('/', (_req: any, res: any) => {
        res.json(scenesHandler.list());
    });

    sc.post('/:id/trigger', async (req: any, res: any) => {
        try {
            const result = await scenesHandler.trigger(req.params.id);
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Champs éditables — un PATCH partiel ne doit jamais écraser le reste. */
    const sceneFields = (body: any) => {
        const {
            name,
            icon,
            color,
            description,
            label,
            setup,
            state,
            favorite,
            intro,
            floating,
        } = body;
        return {
            name,
            icon,
            color,
            description,
            label,
            setup,
            state,
            favorite,
            intro,
            floating,
        };
    };

    sc.post('/', (req: any, res: any) => {
        try {
            const scene = scenesHandler.create(sceneFields(req.body));
            res.status(201).json(scene);
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    sc.delete('/:id', (req: any, res: any) => {
        const ok = scenesHandler.remove(req.params.id);
        if (!ok)
            return res
                .status(404)
                .json({ error: 'Scene not found or is built-in' });
        res.json({ success: true });
    });

    sc.patch('/:id', (req: any, res: any) => {
        try {
            const scene = scenesHandler.update(
                req.params.id,
                sceneFields(req.body),
            );
            if (!scene)
                return res
                    .status(404)
                    .json({ error: 'Scene not found or is built-in' });
            res.json(scene);
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    sc.patch('/:id/favorite', (req: any, res: any) => {
        const scene = scenesHandler.toggleFavorite(req.params.id);
        if (!scene) return res.status(404).json({ error: 'Scene not found' });
        res.json({ scene });
    });

    return sc;
}
