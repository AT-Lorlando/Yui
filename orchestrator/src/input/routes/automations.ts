// Automations / cron — monté sur /automations.
import express from 'express';
import { loadHistory } from '../../orchestrator/history';
import type { AutomationsHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

export function automationRoutes(
    requireAuth: RequireAuth,
    automationsHandler: AutomationsHandler,
): express.Router {
    const auto = express.Router();
    auto.use(requireAuth);

    auto.get('/', (_req: any, res: any) => {
        res.json(automationsHandler.list());
    });

    auto.get('/history', (_req: any, res: any) => {
        res.json(loadHistory());
    });

    auto.post('/', (req: any, res: any) => {
        try {
            const automation = automationsHandler.add(req.body);
            res.status(201).json(automation);
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    auto.patch('/:id', (req: any, res: any) => {
        try {
            const { name, trigger, action, notify, enabled } = req.body;
            const result = automationsHandler.update(req.params.id, {
                name,
                trigger,
                action,
                notify,
                enabled,
            });
            if (!result)
                return res.status(404).json({ error: 'Automation not found' });
            res.json(result);
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    auto.patch('/:id/toggle', (req: any, res: any) => {
        const msg = automationsHandler.toggle(req.params.id);
        if (msg === null)
            return res.status(404).json({ error: 'Automation not found' });
        res.json({ message: msg });
    });

    auto.delete('/:id', (req: any, res: any) => {
        const ok = automationsHandler.remove(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Automation not found' });
        res.json({ success: true });
    });

    auto.post('/:id/run', async (req: any, res: any) => {
        try {
            const result = await automationsHandler.run(req.params.id);
            if (!result.success)
                return res.status(404).json({ error: result.error });
            res.json({ success: true });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    return auto;
}
