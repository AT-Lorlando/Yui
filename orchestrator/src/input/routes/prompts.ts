// Prompts (fichiers markdown + manifest) — monté sur /prompts.
import express from 'express';
import {
    listPrompts,
    writePrompt,
    loadManifest,
    createPrompt,
    deletePrompt,
    updatePromptEntry,
    importPromptFromUrl,
} from '../../orchestrator/prompts';
import { expectedDomains } from '../../orchestrator/configCatalog';
import type { RequireAuth } from './helpers';

export function promptRoutes(requireAuth: RequireAuth): express.Router {
    const r = express.Router();
    r.use(requireAuth);

    // List files + their manifest policy (layer/enabled/order/domain).
    r.get('/', (_req: any, res: any) => {
        // domains = the domain prompt slots the orchestrator can load, so
        // the front can show expected (possibly missing) domain files.
        res.json({
            files: listPrompts(),
            manifest: loadManifest(),
            domains: expectedDomains(),
        });
    });

    // Create a new prompt file (+ manifest entry).
    r.post('/', (req: any, res: any) => {
        const { file, content, layer, domain, enabled } = req.body ?? {};
        if (typeof file !== 'string' || typeof content !== 'string') {
            return res
                .status(400)
                .json({ error: 'file and content must be strings' });
        }
        try {
            const manifest = createPrompt(file, content, {
                layer,
                domain,
                enabled,
            });
            res.json({ success: true, manifest });
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    // Import a prompt from a URL (created or overwritten, disabled by
    // default so a heavy prompt never silently inflates every request).
    r.post('/import', async (req: any, res: any) => {
        const { file, url, layer, domain, enabled } = req.body ?? {};
        if (typeof file !== 'string' || typeof url !== 'string') {
            return res
                .status(400)
                .json({ error: 'file and url must be strings' });
        }
        try {
            const manifest = await importPromptFromUrl(file, url, {
                layer,
                domain,
                enabled,
            });
            res.json({ success: true, manifest });
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    // Patch a manifest entry (enabled / order / domain / layer).
    r.patch('/manifest/*', (req: any, res: any) => {
        try {
            const manifest = updatePromptEntry(req.params[0], req.body ?? {});
            res.json({ success: true, manifest });
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    // Delete a prompt file (+ manifest entry).
    r.delete('/*', (req: any, res: any) => {
        try {
            const manifest = deletePrompt(req.params[0]);
            res.json({ success: true, manifest });
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    // Overwrite an existing prompt file's content. :file may contain
    // slashes (sub-folders) → wildcard param.
    r.put('/*', (req: any, res: any) => {
        const file = req.params[0];
        const { content } = req.body ?? {};
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'content must be a string' });
        }
        try {
            writePrompt(file, content);
            res.json({ success: true });
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    return r;
}
