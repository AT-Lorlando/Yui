// Page /mail (Courrier v3) : listes d'expéditeurs (à garder / osef), inconnus,
// ordres de lecture, essai à blanc, journal, bilan, scan et rapport de
// migration.
//
// ⚠️ Monté sur '/' : auth PAR ROUTE, jamais en `router.use` (cf. events.ts).
// Les bornes d'entrée sont vérifiées ici (400 propre) ; les stores
// revalident et leurs erreurs de validation remontent aussi en 400.
import express from 'express';
import * as fs from 'fs';
import { dataPath } from '@yui/shared';
import type { ProactiveHandler } from '../InputSource';
import { NotFoundError } from '../../orchestrator/proactive/mail/errors';
import type { RequireAuth } from './helpers';

export type MailHandler = Pick<
    ProactiveHandler,
    | 'mailSendersFile'
    | 'mailSendersReplace'
    | 'mailSenderKeep'
    | 'mailSenderSpam'
    | 'mailSenderDelete'
    | 'mailSenderApply'
    | 'mailUnknown'
    | 'mailOrders'
    | 'mailOrderAdd'
    | 'mailOrderDelete'
    | 'mailDryRun'
    | 'mailJournal'
    | 'mailStats'
    | 'mailScan'
    | 'mailMigration'
>;

const UNAVAILABLE = { error: 'proactivité indisponible' };
const MATCH_MIN = 2;
const NAME_MAX = 40;
const ORDER_DAYS_MAX = 60;
const ORDER_DEFAULT_DAYS = 14;
const APPLY_MAX = 200;
const APPLY_DEFAULT = 100;
const DRY_RUN_MAX = 100;
const JOURNAL_DEFAULT = 50;
const JOURNAL_MAX = 200;
const STATS_DAYS_MAX = 90;
const STATS_DAYS_DEFAULT = 7;

class BadRequest extends Error {}

/** Entier dans [min, max], `def` si absent ; hors bornes → 400 (pas de clamp silencieux). */
function boundedInt(
    raw: unknown,
    name: string,
    min: number,
    max: number,
    def: number,
): number {
    if (raw === undefined || raw === null || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new BadRequest(
            `${name} doit être un entier entre ${min} et ${max}`,
        );
    }
    return n;
}

function cleanMatch(raw: unknown): string {
    const match = typeof raw === 'string' ? raw.trim() : '';
    if (match.length < MATCH_MIN) {
        throw new BadRequest(
            `match doit faire au moins ${MATCH_MIN} caractères`,
        );
    }
    return match;
}

function cleanName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || name.length > NAME_MAX || name.includes('/')) {
        throw new BadRequest(
            `name doit faire 1 à ${NAME_MAX} caractères, sans "/"`,
        );
    }
    return name;
}

export function mailRoutes(
    requireAuth: RequireAuth,
    h?: MailHandler,
): express.Router {
    const r = express.Router();

    /** 503 sans handler, 400 sur entrée invalide ou erreur de validation du store, sinon 500. */
    const route = (
        method: 'get' | 'post' | 'put' | 'delete',
        path: string,
        needs: keyof MailHandler,
        fn: (req: any, res: any) => unknown | Promise<unknown>,
    ) => {
        r[method](path, requireAuth, async (req: any, res: any) => {
            if (!h?.[needs]) {
                res.status(503).json(UNAVAILABLE);
                return;
            }
            try {
                await fn(req, res);
            } catch (e: any) {
                const msg = e instanceof Error ? e.message : String(e);
                if (e instanceof BadRequest) {
                    res.status(400).json({ error: msg });
                } else if (e instanceof NotFoundError) {
                    res.status(404).json({ error: msg });
                } else {
                    res.status(500).json({ error: msg });
                }
            }
        });
    };

    route('get', '/mail/senders', 'mailSendersFile', (_req, res) => {
        res.json(h!.mailSendersFile!());
    });

    // Le store lève une Error ordinaire sur fichier invalide : sur ce PUT,
    // toute erreur est une erreur de validation (400).
    route('put', '/mail/senders', 'mailSendersReplace', (req, res) => {
        try {
            res.json(h!.mailSendersReplace!(req.body));
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    route('post', '/mail/senders/keep', 'mailSenderKeep', (req, res) => {
        const b = req.body ?? {};
        const input: Record<string, unknown> = {
            match: cleanMatch(b.match),
            name: cleanName(b.name),
        };
        for (const k of ['read', 'rules', 'readDefault']) {
            if (b[k] !== undefined) input[k] = b[k];
        }
        if (
            input.read !== undefined &&
            !['always', 'never', 'rules'].includes(input.read as string)
        ) {
            throw new BadRequest('read doit valoir always, never ou rules');
        }
        try {
            res.status(201).json(h!.mailSenderKeep!(input as any));
        } catch (e: any) {
            // validation des règles/champs par le store : rien n'a été écrit
            res.status(400).json({ error: e.message });
        }
    });

    route('post', '/mail/senders/spam', 'mailSenderSpam', (req, res) => {
        res.status(201).json(h!.mailSenderSpam!(cleanMatch(req.body?.match)));
    });

    route('delete', '/mail/senders/:id', 'mailSenderDelete', (req, res) => {
        if (h!.mailSenderDelete!(String(req.params.id))) res.status(204).end();
        else res.status(404).json({ error: 'expéditeur introuvable' });
    });

    route(
        'post',
        '/mail/senders/:id/apply',
        'mailSenderApply',
        async (req, res) => {
            const max = boundedInt(
                req.body?.max,
                'max',
                1,
                APPLY_MAX,
                APPLY_DEFAULT,
            );
            res.json(await h!.mailSenderApply!(String(req.params.id), max));
        },
    );

    route('get', '/mail/unknown', 'mailUnknown', (_req, res) => {
        res.json(h!.mailUnknown!());
    });

    route('get', '/mail/orders', 'mailOrders', (_req, res) => {
        res.json(h!.mailOrders!());
    });

    route('post', '/mail/orders', 'mailOrderAdd', (req, res) => {
        const text =
            typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!text) throw new BadRequest('text est requis');
        const days = boundedInt(
            req.body?.days,
            'days',
            1,
            ORDER_DAYS_MAX,
            ORDER_DEFAULT_DAYS,
        );
        try {
            res.status(201).json(h!.mailOrderAdd!(text, days));
        } catch (e: any) {
            // texte trop long, plafond d'ordres actifs : erreurs du store
            res.status(400).json({ error: e.message });
        }
    });

    route('delete', '/mail/orders/:id', 'mailOrderDelete', (req, res) => {
        if (h!.mailOrderDelete!(String(req.params.id))) res.status(204).end();
        else res.status(404).json({ error: 'ordre introuvable' });
    });

    route('post', '/mail/dry-run', 'mailDryRun', async (req, res) => {
        const query =
            typeof req.body?.query === 'string' && req.body.query.trim()
                ? req.body.query.trim()
                : undefined;
        const max = boundedInt(
            req.body?.max,
            'max',
            1,
            DRY_RUN_MAX,
            DRY_RUN_MAX,
        );
        res.json(await h!.mailDryRun!(query, max));
    });

    route('get', '/mail/journal', 'mailJournal', (req, res) => {
        // limite hors bornes : plafonnée (lecture seule, comportement historique)
        const n = Number(req.query.limit);
        const limit =
            Number.isInteger(n) && n > 0
                ? Math.min(n, JOURNAL_MAX)
                : JOURNAL_DEFAULT;
        const scope = req.query.scope === 'actions' ? 'actions' : undefined;
        res.json(h!.mailJournal!(limit, scope));
    });

    route('get', '/mail/stats', 'mailStats', (req, res) => {
        const days = boundedInt(
            req.query.days,
            'days',
            1,
            STATS_DAYS_MAX,
            STATS_DAYS_DEFAULT,
        );
        res.json(h!.mailStats!(days));
    });

    route('post', '/mail/scan', 'mailScan', async (_req, res) => {
        res.json(await h!.mailScan!());
    });

    route('get', '/mail/migration', 'mailMigration', (_req, res) => {
        const report = h!.mailMigration!();
        if (report === null || report === undefined) {
            res.status(404).json({ error: 'aucune migration' });
        } else res.json(report);
    });

    return r;
}

/** Contenu de `mail-migration.json`, ou null (absent / illisible). */
export function readMigrationReport(): unknown | null {
    try {
        return JSON.parse(
            fs.readFileSync(dataPath('mail-migration.json'), 'utf8'),
        );
    } catch {
        return null;
    }
}
