// `POST /events` — les autres dépôts poussent des événements dans le bus ;
// contrairement à /notify, ils ne décident pas si Jérémy sera dérangé :
// péremption, dédup, cooldown et juge s'appliquent. Docs : docs/events-api.md.
//
// ⚠️ Monté sur '/' : auth PAR ROUTE, jamais en `router.use` (cf. effects.ts).
import express from 'express';
import { logActivity } from '../../orchestrator/activityLog';
import { parseEvents } from '../../orchestrator/proactive/events';
import type { Event } from '../../orchestrator/proactive/events';
import type { IngestOutcome } from '../../orchestrator/proactive/ingest';
import type { RequireAuth } from './helpers';

export interface EventsIngest {
    ingest?: (events: Event[]) => Promise<Record<IngestOutcome, number>>;
}

// `HttpSource` pose déjà `bodyParser.json()` en global (limite 100 Ko) avant
// que cette route ne soit atteinte : le corps arrive donc déjà parsé et
// `express.json({limit})` posé ici ne rejoue rien (body-parser saute un
// corps déjà consommé). La borne de 32 Ko est donc vérifiée à la main, sur
// `content-length` — repli sur la taille du JSON déjà parsé si l'en-tête est
// absent (corps chunké).
const BODY_LIMIT_BYTES = 32 * 1024;

function isBodyTooLarge(req: any): boolean {
    const len = Number(req.headers?.['content-length']);
    if (Number.isFinite(len) && len > 0) return len > BODY_LIMIT_BYTES;
    try {
        return (
            Buffer.byteLength(JSON.stringify(req.body ?? {})) > BODY_LIMIT_BYTES
        );
    } catch {
        return false;
    }
}

export function eventRoutes(
    requireAuth: RequireAuth,
    proactive?: EventsIngest,
): express.Router {
    const r = express.Router();

    r.post(
        '/events',
        requireAuth,
        express.json({ limit: '32kb' }),
        async (req: any, res: any) => {
            if (isBodyTooLarge(req)) {
                return res
                    .status(413)
                    .json({ error: 'corps trop volumineux (32 Ko max)' });
            }
            if (!proactive?.ingest) {
                return res
                    .status(503)
                    .json({ error: 'proactivité non disponible' });
            }
            const { events, errors } = parseEvents(req.body);
            if (errors.length) return res.status(400).json({ errors });
            const counts = await proactive.ingest(events);
            const sources = [...new Set(events.map((e) => e.source))].join(
                ', ',
            );
            logActivity(
                'event',
                sources,
                `${events.length} événement(s) — acceptés ${counts.accepted}, retenus ${counts.held}, doublons ${counts.deduplicated}, périmés ${counts.expired}`,
            );
            res.status(202).json(counts);
        },
    );

    return r;
}
