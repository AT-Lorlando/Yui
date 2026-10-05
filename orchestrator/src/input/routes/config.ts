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
    applyOrchestratorEnv,
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

function isBriefScope(v: unknown): v is 'since-last' | 'today' | 'pending' {
    return v === 'since-last' || v === 'today' || v === 'pending';
}

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
        // Borné : un `limit` négatif ferait `slice(-limit)` → presque tout le ring.
        const rawLimit = Number(req.query?.limit);
        const limit =
            Number.isFinite(rawLimit) && rawLimit >= 1
                ? Math.min(300, Math.max(1, Math.trunc(rawLimit)))
                : 60;
        let before: number | undefined;
        if (req.query?.before !== undefined) {
            before = Number(req.query.before);
            if (!Number.isFinite(before)) {
                res.status(400).json({ error: 'before doit être numérique' });
                return;
            }
        }
        res.json(proactiveHandler?.journal?.(limit, before) ?? []);
    });

    // ── Réserve (retenus) et mémoire « dit » — page Secrétaire ───────
    const UNAVAILABLE = { error: 'proactivité indisponible' };
    r.get('/proactive/held', requireAuth, (_req: any, res: any) => {
        if (!proactiveHandler?.held) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        res.json(proactiveHandler.held());
    });
    r.delete('/proactive/held/:key', requireAuth, (req: any, res: any) => {
        if (!proactiveHandler?.heldRemove) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        // Express décode déjà `:key` ; `source:key` contient des « : » et
        // parfois « / » encodé.
        if (proactiveHandler.heldRemove(String(req.params.key)))
            res.json({ ok: true });
        else res.status(404).json({ error: 'retenu inconnu' });
    });
    r.get('/proactive/said', requireAuth, (_req: any, res: any) => {
        if (!proactiveHandler?.said) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        res.json(proactiveHandler.said());
    });
    r.delete('/proactive/said/:subject', requireAuth, (req: any, res: any) => {
        if (!proactiveHandler?.saidForget) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        // Express décode `req.params` : le sujet doit arriver encodé, un `/` littéral n'est pas adressable ici.
        if (proactiveHandler.saidForget(String(req.params.subject)))
            res.json({ ok: true });
        else res.status(404).json({ error: 'sujet inconnu' });
    });
    r.delete('/proactive/said', requireAuth, (_req: any, res: any) => {
        if (!proactiveHandler?.saidForgetAll) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        res.json({ ok: true, removed: proactiveHandler.saidForgetAll() });
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

    // ── Point à la demande (tool LLM secretary_brief + app) ──────────
    // Un scope hors de cette liste ne doit jamais atteindre le moteur — il
    // suppose lui-même le défaut sur une valeur absente, pas sur n'importe quoi.
    r.post('/proactive/brief', requireAuth, async (req: any, res: any) => {
        const scope = req.body?.scope;
        if (scope !== undefined && !isBriefScope(scope)) {
            res.status(400).json({ error: 'scope invalide' });
            return;
        }
        if (!proactiveHandler?.brief) {
            res.status(503).json({ error: 'proactivité indisponible' });
            return;
        }
        try {
            const result = (await proactiveHandler.brief(scope)) as {
                text: string;
                fallback?: boolean;
            };
            res.json(
                result.fallback !== undefined
                    ? { text: result.text, fallback: result.fallback }
                    : { text: result.text },
            );
        } catch (err) {
            res.status(500).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    r.get('/proactive/brief/preview', requireAuth, (req: any, res: any) => {
        const scope = req.query?.scope;
        if (scope !== undefined && !isBriefScope(scope)) {
            res.status(400).json({ error: 'scope invalide' });
            return;
        }
        if (!proactiveHandler?.briefPreview) {
            res.status(503).json({ error: 'proactivité indisponible' });
            return;
        }
        try {
            res.json({ facts: proactiveHandler.briefPreview(scope) });
        } catch (err) {
            res.status(500).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
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

    r.post(
        '/mail/triage/doubts/:id/resolve',
        requireAuth,
        async (req: any, res: any) => {
            try {
                const ok =
                    (await proactiveHandler?.triageResolveDoubt?.(
                        String(req.params.id),
                        {
                            category: req.body?.category,
                            accept: Array.isArray(req.body?.accept)
                                ? req.body.accept.map(Number)
                                : [],
                        },
                    )) ?? false;
                if (!ok) res.status(404).json({ error: 'doute inconnu' });
                else res.json({ ok: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        },
    );

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
            const saved = saveIntegrations(patch);
            // Clés de l'orchestrateur : effectives tout de suite (routeur LLM,
            // providers colis lisent process.env par requête).
            applyOrchestratorEnv(saved);
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
