import express from 'express';
import Logger from '../../logger';
import { pickMornings } from '../../orchestrator/wakeups/occurrences';
import {
    getWakeupRunner,
    WakeupNotFoundError,
} from '../../orchestrator/wakeups/runner';
import {
    readPhoneAlarm,
    readWakeups,
    writePhoneAlarm,
    writeWakeups,
} from '../../orchestrator/wakeups/store';
import type { RequireAuth } from './helpers';

/** État complet ; `next` sans le champ `wakeup` (déjà dans `wakeups`). */
function view() {
    const runner = getWakeupRunner();
    const occs = runner
        ? runner.next()
        : pickMornings(readWakeups(), readPhoneAlarm(), Date.now());
    return {
        wakeups: readWakeups(),
        next: occs.map(({ wakeup: _w, ...o }) => o),
        phoneAlarm: readPhoneAlarm(),
    };
}

export function wakeupRoutes(requireAuth: RequireAuth): express.Router {
    const r = express.Router();

    r.get('/wakeups', requireAuth, (_req: any, res: any) => {
        try {
            res.json(view());
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.put('/wakeups', requireAuth, (req: any, res: any) => {
        try {
            writeWakeups(req.body?.wakeups);
        } catch (e: any) {
            return res.status(400).json({ error: e.message });
        }
        getWakeupRunner()?.reschedule();
        res.json(view());
    });

    r.post('/wake/phone-alarm', requireAuth, (req: any, res: any) => {
        const src = req.body?.source;
        const source =
            typeof src === 'string' && src.length > 0 && src.length <= 32
                ? src
                : 'android';
        let phoneAlarm;
        try {
            phoneAlarm = writePhoneAlarm(req.body?.nextAt, source);
        } catch (e: any) {
            return res.status(400).json({ error: e.message });
        }
        getWakeupRunner()?.reschedule();
        res.json({ ok: true, phoneAlarm });
    });

    r.post('/wakeups/:id/test', requireAuth, (req: any, res: any) => {
        const runner = getWakeupRunner();
        if (!runner)
            return res.status(503).json({ error: 'Réveils non démarrés' });
        const id = String(req.params.id);
        if (!readWakeups().some((w) => w.id === id))
            return res.status(404).json({ error: 'Réveil introuvable' });
        // L'essai dure ~2 min : lancé en tâche de fond.
        runner.test(id).catch((e) => {
            if (!(e instanceof WakeupNotFoundError))
                Logger.error(`[wakeups] essai : ${(e as Error).message}`);
        });
        res.json({ ok: true });
    });

    return r;
}
