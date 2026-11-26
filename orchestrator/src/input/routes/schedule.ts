// Emploi du temps — semaine type, exceptions datées, plan des jours.
//
// ⚠️ Monté sur '/' : auth PAR ROUTE, jamais en `router.use` (cf. effects.ts).
import express from 'express';
import type { CallTool } from '../../orchestrator/agendaSecretary';
import { localYmd } from '../../orchestrator/schedule/dayPlan';
import { getDayPlans } from '../../orchestrator/schedule/service';
import {
    readSchedule,
    removeException,
    setWeek,
    upsertException,
} from '../../orchestrator/schedule/store';
import type { ToolsHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Adaptateur ToolsHandler → CallTool : lève sur `isError`, parse le JSON. */
export function toolsCallTool(toolsHandler: ToolsHandler): CallTool {
    return async (name, args) => {
        const { result, isError } = await toolsHandler.callWithStatus(
            name,
            args ?? {},
        );
        if (isError) throw new Error(String(result));
        if (typeof result === 'string') {
            try {
                return JSON.parse(result);
            } catch {
                return result;
            }
        }
        return result;
    };
}

export function scheduleRoutes(
    requireAuth: RequireAuth,
    toolsHandler?: ToolsHandler,
): express.Router {
    const r = express.Router();
    // Une seule fonction par router : le cache agenda est indexé par elle.
    const callTool = toolsHandler ? toolsCallTool(toolsHandler) : null;

    r.get('/schedule', requireAuth, (_req: any, res: any) => {
        try {
            res.json(readSchedule());
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.put('/schedule/week', requireAuth, (req: any, res: any) => {
        try {
            res.json(setWeek(req.body?.week));
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    r.post('/schedule/exceptions', requireAuth, (req: any, res: any) => {
        try {
            res.json(upsertException(req.body ?? {}));
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    r.delete(
        '/schedule/exceptions/:date',
        requireAuth,
        (req: any, res: any) => {
            const s = removeException(String(req.params.date));
            if (!s)
                return res.status(404).json({ error: 'Exception introuvable' });
            res.json(s);
        },
    );

    r.get('/schedule/plan', requireAuth, async (req: any, res: any) => {
        const from =
            req.query.from === undefined
                ? localYmd(new Date())
                : String(req.query.from);
        const days = req.query.days === undefined ? 7 : Number(req.query.days);
        if (!YMD.test(from))
            return res
                .status(400)
                .json({ error: 'from invalide (YYYY-MM-DD)' });
        if (!Number.isInteger(days) || days < 1 || days > 31) {
            return res
                .status(400)
                .json({ error: 'days doit être entre 1 et 31' });
        }
        try {
            res.json(await getDayPlans(callTool, from, days));
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    return r;
}
