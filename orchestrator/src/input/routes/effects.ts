// Animations lumineuses + bibliothèque d'effets.
//
// ⚠️ Monté sur '/' (chemins historiques /animations/*, /floating/*,
// /effects*) : l'auth est PAR ROUTE, jamais en `router.use` — un middleware
// de router monté à la racine intercepterait TOUTES les requêtes et 401-ait
// les endpoints publics déclarés après (c'est ce qui cassait /chime).
import express from 'express';
import { animationManager } from '../../orchestrator/animation/animationManager';
import {
    deleteEffect,
    listEffects,
    resolveFloating,
    resolveIntro,
    upsertEffect,
} from '../../orchestrator/animation/effectLibrary';
import type { DeviceHandler, ToolsHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

export function effectRoutes(
    requireAuth: RequireAuth,
    deviceHandler: DeviceHandler,
    toolsHandler?: ToolsHandler,
): express.Router {
    const anim = express.Router();

    // Les écritures d'une animation passent par le chemin raw : sinon
    // chaque image déclenche la garde d'annulation et l'aperçu se
    // coupe tout seul dès la première.
    const animCall = toolsHandler?.callRaw ?? deviceHandler;

    // Preview an intro once (no persistence).
    anim.post(
        '/animations/preview',
        requireAuth,
        async (req: any, res: any) => {
            try {
                await animationManager.playIntro(
                    req.body?.intro ?? [],
                    animCall,
                );
                res.json({ success: true });
            } catch (e: any) {
                res.status(400).json({ error: e.message });
            }
        },
    );

    anim.post('/floating/start', requireAuth, async (req: any, res: any) => {
        try {
            await animationManager.startFloating(req.body?.floating, animCall);
            res.json({ success: true });
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    anim.post('/floating/stop', requireAuth, async (_req: any, res: any) => {
        await animationManager.stopAll();
        res.json({ success: true });
    });

    // ── Bibliothèque d'effets ─────────────────────────────────────────
    anim.get('/effects', requireAuth, (_req: any, res: any) => {
        res.json(listEffects());
    });

    anim.post('/effects', requireAuth, (req: any, res: any) => {
        try {
            res.json(upsertEffect(req.body ?? {}));
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    anim.delete('/effects/:id', requireAuth, (req: any, res: any) => {
        if (!deleteEffect(String(req.params.id))) {
            return res.status(404).json({ error: 'Effet introuvable' });
        }
        res.json({ ok: true });
    });

    // Aperçu sur les vraies lampes : floating démarre (stop via
    // /floating/stop), intro joue une fois.
    anim.post(
        '/effects/:id/preview',
        requireAuth,
        async (req: any, res: any) => {
            const id = String(req.params.id);
            const target = String(req.body?.target ?? '');
            if (!target) {
                return res.status(400).json({ error: 'target requis' });
            }
            try {
                const floating = resolveFloating({ effectId: id, target });
                if (floating) {
                    await animationManager.startFloating(floating, animCall);
                    return res.json({ success: true, kind: 'floating' });
                }
                const frames = resolveIntro({ effectId: id, target });
                if (!frames.length) {
                    return res.status(404).json({ error: 'Effet introuvable' });
                }
                await animationManager.playIntro(frames, animCall);
                res.json({ success: true, kind: 'intro' });
            } catch (e: any) {
                res.status(400).json({ error: e.message });
            }
        },
    );

    return anim;
}
