// `POST /notify` — point d'entrée pour les autres dépôts (Koya, Genkin,
// Astronix, Aster…) : pousse une notification sur le téléphone, et la lit à
// voix haute si `speak`. Aucun LLM sur ce chemin : ce que l'app envoie est
// ce qui s'affiche. Documentation : docs/notify-api.md.
//
// ⚠️ Monté sur '/' : auth PAR ROUTE, jamais en `router.use` (cf. effects.ts).
import express from 'express';
import { logActivity } from '../../orchestrator/activityLog';
import { pushNotification, speakText } from '../../orchestrator/notify';
import { parseNotifyRequest } from '../../orchestrator/notifyRequest';
import type { RequireAuth } from './helpers';

export function notifyRoutes(requireAuth: RequireAuth): express.Router {
    const r = express.Router();

    r.post('/notify', requireAuth, async (req: any, res: any) => {
        let n;
        try {
            n = parseNotifyRequest(req.body);
        } catch (e: any) {
            return res.status(400).json({ error: e.message });
        }
        logActivity('notify', n.source ?? n.title, n.text);
        const pushed = await pushNotification(n.text, { title: n.title });
        const spoken = n.speak ? await speakText(n.text) : false;
        res.json({ ok: true, pushed, spoken });
    });

    return r;
}
