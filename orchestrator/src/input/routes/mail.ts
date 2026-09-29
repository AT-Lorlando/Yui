// Page /mail : règles manuelles, quarantaine des signaux, pile à lire,
// journal de tri. `GET /mail/triage` et les actions de scan/apply/correct
// restent dans config.ts (chemin historique) — ce fichier ne couvre que ce
// qu'ajoute la quarantaine.
//
// ⚠️ Monté sur '/' : auth PAR ROUTE, jamais en `router.use` (cf. events.ts).
import express from 'express';
import type { ProactiveHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

export type MailHandler = Pick<
    ProactiveHandler,
    | 'mailRules'
    | 'mailRuleSave'
    | 'mailRuleDelete'
    | 'mailQuarantine'
    | 'mailQuarantineAct'
    | 'mailReading'
    | 'mailMarkRead'
    | 'mailJournal'
    | 'mailDryRun'
    | 'mailClassify'
    | 'mailRulesRaw'
    | 'mailRulesReplace'
>;

const UNAVAILABLE = { error: 'proactivité indisponible' };
const QUARANTINE_ACTIONS = new Set(['confirm', 'correct', 'reject']);
const JOURNAL_DEFAULT_LIMIT = 50;
const JOURNAL_MAX_LIMIT = 200;
// Bornes de l'essai à blanc et du classement à la demande — mêmes plafonds
// que le poll automatique côté concierge (`LLM_PER_POLL`), pour éviter
// qu'un appel direct dépasse ce que le concierge accepterait lui-même.
const DRY_RUN_MAX_LIMIT = 200;
const CLASSIFY_MAX_IDS = 24;
// Le concierge lève cette erreur précise quand `correct` reçoit une
// catégorie qui n'existe pas — la route la distingue d'un id de règle
// inconnu (404) pour répondre 400 (requête mal formée) à la place.
const UNKNOWN_CATEGORY_MESSAGE = 'catégorie inconnue';

export function mailRoutes(
    requireAuth: RequireAuth,
    h?: MailHandler,
): express.Router {
    const r = express.Router();

    r.get('/mail/rules', requireAuth, (_req: any, res: any) => {
        if (!h?.mailRules) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        try {
            const rules =
                (h.mailRules() as Array<{
                    origin: string;
                    confirmed: boolean;
                }>) ?? [];
            // les signaux non confirmés vivent dans la quarantaine (page
            // dédiée) — les montrer aussi ici doublonnerait la même décision
            // à deux endroits
            res.json(
                rules.filter(
                    (rule) => !(rule.origin === 'signal' && !rule.confirmed),
                ),
            );
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.post('/mail/rules', requireAuth, (req: any, res: any) => {
        if (!h?.mailRuleSave) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        try {
            const result = h.mailRuleSave(req.body) as
                | { ok: true; rule: unknown }
                | { ok: false; error: string };
            if (!result.ok) {
                res.status(400).json({ error: result.error });
                return;
            }
            res.json(result.rule);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.delete('/mail/rules/:id', requireAuth, (req: any, res: any) => {
        if (!h?.mailRuleDelete) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        try {
            const ok = h.mailRuleDelete(String(req.params.id));
            if (!ok) {
                res.status(404).json({ error: 'règle inconnue' });
                return;
            }
            res.json({ ok: true });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.get('/mail/quarantine', requireAuth, (_req: any, res: any) => {
        if (!h?.mailQuarantine) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        try {
            res.json(h.mailQuarantine());
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.post(
        '/mail/quarantine/:id/:action',
        requireAuth,
        async (req: any, res: any) => {
            const action = String(req.params.action);
            if (!QUARANTINE_ACTIONS.has(action)) {
                res.status(400).json({ error: 'action inconnue' });
                return;
            }
            if (!h?.mailQuarantineAct) {
                res.status(503).json(UNAVAILABLE);
                return;
            }
            // catégorie requise pour corriger : requête mal formée, refusée
            // avant même de savoir si la règle existe (404 réservé à ça).
            if (
                action === 'correct' &&
                typeof req.body?.category !== 'string'
            ) {
                res.status(400).json({
                    error: 'catégorie requise pour corriger',
                });
                return;
            }
            try {
                const ok = await h.mailQuarantineAct(
                    String(req.params.id),
                    action,
                    { category: req.body?.category },
                );
                if (!ok) {
                    res.status(404).json({ error: 'règle inconnue' });
                    return;
                }
                res.json({ ok: true });
            } catch (e: any) {
                if (e?.message === UNKNOWN_CATEGORY_MESSAGE) {
                    res.status(400).json({ error: e.message });
                    return;
                }
                res.status(500).json({ error: e.message });
            }
        },
    );

    r.get('/mail/reading', requireAuth, async (_req: any, res: any) => {
        if (!h?.mailReading) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        try {
            res.json(await h.mailReading());
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.post(
        '/mail/reading/:id/read',
        requireAuth,
        async (req: any, res: any) => {
            if (!h?.mailMarkRead) {
                res.status(503).json(UNAVAILABLE);
                return;
            }
            try {
                await h.mailMarkRead(String(req.params.id));
                res.json({ ok: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        },
    );

    r.get('/mail/journal', requireAuth, (req: any, res: any) => {
        if (!h?.mailJournal) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        const raw = Number(req.query?.limit ?? JOURNAL_DEFAULT_LIMIT);
        const limit = Math.min(
            JOURNAL_MAX_LIMIT,
            Math.max(1, Number.isFinite(raw) ? raw : JOURNAL_DEFAULT_LIMIT),
        );
        try {
            res.json(h.mailJournal(limit));
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.post('/mail/rules/dry-run', requireAuth, async (req: any, res: any) => {
        if (!h?.mailDryRun) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        const { query, max } = req.body ?? {};
        if (query !== undefined && typeof query !== 'string') {
            res.status(400).json({ error: 'query doit être une chaîne' });
            return;
        }
        if (
            max !== undefined &&
            (typeof max !== 'number' || max > DRY_RUN_MAX_LIMIT)
        ) {
            res.status(400).json({
                error: `max doit être un nombre ≤ ${DRY_RUN_MAX_LIMIT}`,
            });
            return;
        }
        try {
            res.json(await h.mailDryRun(query, max));
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.post('/mail/triage/classify', requireAuth, async (req: any, res: any) => {
        if (!h?.mailClassify) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        const mailIds = req.body?.mailIds;
        if (
            !Array.isArray(mailIds) ||
            mailIds.length < 1 ||
            mailIds.length > CLASSIFY_MAX_IDS ||
            !mailIds.every((id: unknown) => typeof id === 'string')
        ) {
            res.status(400).json({
                error: `mailIds doit contenir de 1 à ${CLASSIFY_MAX_IDS} identifiants`,
            });
            return;
        }
        try {
            res.json(await h.mailClassify(mailIds));
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.get('/mail/rules/raw', requireAuth, (_req: any, res: any) => {
        if (!h?.mailRulesRaw) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        try {
            res.json(h.mailRulesRaw());
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.put('/mail/rules', requireAuth, (req: any, res: any) => {
        if (!h?.mailRulesReplace) {
            res.status(503).json(UNAVAILABLE);
            return;
        }
        try {
            const result = h.mailRulesReplace(req.body) as
                | { ok: true; count: number }
                | { ok: false; errors: unknown };
            if (!result.ok) {
                res.status(400).json({ errors: result.errors });
                return;
            }
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    return r;
}
