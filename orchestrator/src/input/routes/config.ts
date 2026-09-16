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

    // ── Proactivité : briques, journal du juge, feedback ─────────────
    r.get('/proactive/bricks', requireAuth, (_req: any, res: any) => {
        res.json(proactiveHandler?.bricks?.() ?? []);
    });
    r.get('/proactive/journal', requireAuth, (req: any, res: any) => {
        const limit = Number(req.query?.limit ?? 50) || 50;
        res.json(proactiveHandler?.journal?.(limit) ?? []);
    });
    r.post(
        '/proactive/journal/:id/feedback',
        requireAuth,
        (req: any, res: any) => {
            const value = req.body?.value;
            if (value !== 'up' && value !== 'down') {
                res.status(400).json({ error: 'value doit être up ou down' });
                return;
            }
            const ok =
                proactiveHandler?.feedback?.(String(req.params.id), value) ??
                false;
            if (!ok) res.status(404).json({ error: 'intervention inconnue' });
            else res.json({ ok: true });
        },
    );
    r.get('/proactive/situation', requireAuth, (_req: any, res: any) => {
        res.json(proactiveHandler?.situation?.() ?? null);
    });

    // ── Concierge courrier (tri Gmail) ───────────────────────────────
    r.get('/mail/triage', requireAuth, (_req: any, res: any) => {
        res.json(proactiveHandler?.triage?.() ?? null);
    });
    r.post('/mail/triage/scan', requireAuth, async (req: any, res: any) => {
        try {
            res.json(
                (await proactiveHandler?.triageScan?.(
                    req.body?.query,
                    req.body?.max,
                )) ?? null,
            );
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });
    r.post('/mail/triage/apply', requireAuth, async (req: any, res: any) => {
        try {
            const applied =
                (await proactiveHandler?.triageApply?.({
                    category: req.body?.category,
                    mailIds: req.body?.mailIds,
                })) ?? 0;
            res.json({ applied });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });
    r.post('/mail/triage/correct', requireAuth, async (req: any, res: any) => {
        try {
            const ok =
                (await proactiveHandler?.triageCorrect?.(
                    String(req.body?.mailId ?? ''),
                    String(req.body?.category ?? ''),
                )) ?? false;
            if (!ok) res.status(404).json({ error: 'mail inconnu' });
            else res.json({ ok: true });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
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
