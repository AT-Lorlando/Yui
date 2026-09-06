// Mémoire de Yui — monté sur /memory.
import express from 'express';
import {
    loadStore,
    saveMemory,
    deleteMemory,
    setNamespacePriority,
    deleteNamespace,
} from '../../orchestrator/memory';
import type { RequireAuth } from './helpers';

export function memoryRoutes(requireAuth: RequireAuth): express.Router {
    const r = express.Router();
    r.use(requireAuth);

    r.get('/', (_req: any, res: any) => {
        res.json(loadStore());
    });

    r.post('/', (req: any, res: any) => {
        const { namespace, key, value, priority } = req.body ?? {};
        if (typeof namespace !== 'string' || !namespace.trim()) {
            return res.status(400).json({ error: 'namespace is required' });
        }
        if (priority && priority !== 'always' && priority !== 'on-demand') {
            return res
                .status(400)
                .json({ error: 'priority must be always or on-demand' });
        }
        if (key !== undefined) {
            if (typeof key !== 'string' || typeof value !== 'string') {
                return res
                    .status(400)
                    .json({ error: 'key and value must be strings' });
            }
            if (key === '_priority') {
                return res.status(400).json({ error: '_priority is reserved' });
            }
            saveMemory(namespace, key, value, priority ?? 'always');
        } else if (priority) {
            setNamespacePriority(namespace, priority);
        } else {
            setNamespacePriority(namespace, 'always');
        }
        res.json(loadStore());
    });

    r.delete('/:namespace/:key', (req: any, res: any) => {
        if (req.params.key === '_priority') {
            return res.status(400).json({ error: '_priority is reserved' });
        }
        deleteMemory(req.params.namespace, req.params.key);
        res.json(loadStore());
    });

    r.delete('/:namespace', (req: any, res: any) => {
        deleteNamespace(req.params.namespace);
        res.json(loadStore());
    });

    return r;
}
