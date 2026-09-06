// Configuration d'instance : settings, proactivité, fichiers data/*.json,
// intégrations, irrigation, télécommandes Hue. Monté sur '/' (chemins
// historiques) — auth PAR ROUTE.
import express from 'express';
import Logger from '../../logger';
import { getSettings, updateSettings, applyToEnv } from '../../settings';
import { loadConfig, saveConfig } from '../../orchestrator/proactive/config';
import {
    loadIntegrations,
    saveIntegrations,
    maskIntegrations,
} from '../../orchestrator/integrations';
import {
    listDataFiles,
    readDataFile,
    writeDataFile,
} from '../../orchestrator/dataFiles';
import { INTEGRATIONS_CATALOG } from '../../orchestrator/configCatalog';
import {
    loadIrrigationConfig,
    saveIrrigationConfig,
} from '../../orchestrator/irrigationConfig';
import {
    getRemotesSnapshot,
    saveRemotesConfig,
} from '../../orchestrator/hueRemotes';
import type { IntegrationsHandler, ProactiveHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

export function configRoutes(
    requireAuth: RequireAuth,
    integrationsHandler?: IntegrationsHandler,
    proactiveHandler?: ProactiveHandler,
): express.Router {
    const r = express.Router();

    r.get('/settings', requireAuth, (_req: any, res: any) => {
        res.json(getSettings());
    });

    r.put('/settings', requireAuth, (req: any, res: any) => {
        try {
            const saved = updateSettings(req.body ?? {});
            // Apply live: patch process.env + adjust the logger level.
            // Per-request consumers (LLM model, TTS) pick it up immediately;
            // module-level constants (presence) take effect on next restart.
            applyToEnv(saved);
            (Logger as any).level = saved.logging.level;
            res.json(saved);
        } catch (err) {
            res.status(400).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    // ── Proactivité (data/proactive.json) ────────────────────────────
    r.get('/proactive', requireAuth, (_req: any, res: any) => {
        res.json(loadConfig());
    });

    r.put('/proactive', requireAuth, (req: any, res: any) => {
        try {
            const saved = saveConfig(req.body ?? {});
            // Apply live: restart watchers with the new config.
            proactiveHandler?.reload();
            res.json(saved);
        } catch (err) {
            res.status(400).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    // ── Raw data/*.json editor (guardrailed) ─────────────────────────
    r.get('/data', requireAuth, (_req: any, res: any) => {
        res.json({ files: listDataFiles() });
    });

    r.get('/data/*', requireAuth, (req: any, res: any) => {
        try {
            res.json({ content: readDataFile(req.params[0]) });
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    r.put('/data/*', requireAuth, (req: any, res: any) => {
        const { content } = req.body ?? {};
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'content must be a string' });
        }
        try {
            writeDataFile(req.params[0], content);
            res.json({ success: true });
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    r.get('/integrations', requireAuth, (_req: any, res: any) => {
        // servers = current values (masked) ; catalog = expected keys per
        // server so the front can render placeholders for unset infra.
        res.json({
            servers: maskIntegrations(loadIntegrations()),
            catalog: INTEGRATIONS_CATALOG,
        });
    });

    r.put('/integrations', requireAuth, async (req: any, res: any) => {
        try {
            const patch = req.body?.servers ?? req.body ?? {};
            saveIntegrations(patch);
            // Respawn only the servers touched by this patch.
            const affected = Object.keys(patch);
            const reconnected: string[] = [];
            if (integrationsHandler) {
                for (const name of affected) {
                    if (await integrationsHandler.reconnect(name))
                        reconnected.push(name);
                }
            }
            res.json({
                servers: maskIntegrations(loadIntegrations()),
                reconnected,
            });
        } catch (err) {
            res.status(400).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    r.get('/irrigation/config', requireAuth, (_req: any, res: any) => {
        res.json(loadIrrigationConfig());
    });

    r.put('/irrigation/config', requireAuth, (req: any, res: any) => {
        try {
            const saved = saveIrrigationConfig(req.body);
            res.json(saved);
        } catch (err) {
            res.status(400).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    r.get('/remotes/hue', requireAuth, (_req: any, res: any) => {
        res.json(getRemotesSnapshot());
    });

    r.put('/remotes/hue', requireAuth, (req: any, res: any) => {
        try {
            const saved = saveRemotesConfig(req.body);
            res.json({ ...getRemotesSnapshot(), config: saved });
        } catch (err) {
            res.status(400).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    return r;
}
