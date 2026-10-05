// Courrier : si le réglage `triage` est actif, le concierge (règles → LLM →
// labels) est SEUL maître du courrier — ses propositions « action » et ses
// doutes deviennent des événements. Sinon, le veilleur historique des mails
// « importants » Gmail (evaluateMail), plafonné à `utile` : il n'a ni urgence
// ni classement, donc jamais le juge — ce qu'il remonte est retenu et dit au
// prochain point, sous la garde du lexique. Le tri n'a plus de timer à part :
// c'est le poll de ce connecteur.
import { evaluateMail } from '../watchers/mail';
import {
    fromCandidate,
    SUBJECT_MAX,
    TODO_TITLE_MAX,
    TODO_DESCRIPTION_MAX,
} from '../events';
import type { Event, Fact } from '../events';
import type { Importance } from '../types';
import type { ConnectorDef } from '../connector';
import type { MailConcierge, TriageProposal } from '../mail/concierge';

export const DEFAULT_MAIL_QUERY = 'is:important is:unread newer_than:1d';
const DOUBTS_COOLDOWN_MS = 3 * 3600_000;
/** Un mail à traiter reste pertinent une semaine. */
const ACTION_TTL_MS = 7 * 24 * 3600_000;
/** Ids déjà signalés gardés en mémoire — borne la taille de l'état. */
const MAX_SIGNALED = 500;
/** Sujets « à traiter » exposés au journal de situation. */
const MAX_SNAPSHOT_ACTIONS = 5;
/** Mails "now" traités en urgent par jour — au-delà, importance rabattue en
 *  "utile" (le juge/budget quotidien reste la dernière digue). */
export const MAIL_URGENT_PER_DAY = 2;
/** Seule une « action » (un geste attendu de Jérémy) peut être urgente :
 *  `category === 'action' && urgency === 'now'`, sous le plafond quotidien.
 *  Toute autre catégorie classée "now" (securite, lire, notification…) est
 *  traitée comme "soon" — événement `utile`, raison dans les faits, retenu
 *  pour le prochain point — le juge ne brode donc jamais sur une alerte de
 *  sécurité (vécu 01/10 : « piratage en cours »). Pur. */
export function isUrgentMail(
    p: Pick<TriageProposal, 'category' | 'urgency'>,
): boolean {
    return p.category === 'action' && p.urgency === 'now';
}
/** Plafond d'importance du veilleur historique — jamais `urgent`. */
export const LEGACY_MAIL_MAX_IMPORTANCE: Importance = 'utile';

const IMPORTANCE_RANK: Record<Importance, number> = {
    info: 0,
    utile: 1,
    urgent: 2,
    critique: 3,
};

/** Rabat une importance au plafond du veilleur historique. Pur. */
export function capLegacyImportance(importance: Importance): Importance {
    return IMPORTANCE_RANK[importance] >
        IMPORTANCE_RANK[LEGACY_MAIL_MAX_IMPORTANCE]
        ? LEGACY_MAIL_MAX_IMPORTANCE
        : importance;
}

const VIA_LABEL: Record<TriageProposal['via'], string> = {
    rule: 'par une règle',
    signal: 'par un signal de masse',
    fallback: 'par défaut (IA indisponible)',
    llm: 'par le concierge',
};

/** Jour local (YYYY-MM-DD) — assiette du plafond quotidien d'urgences. */
function localDay(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function mailConnector(services: {
    concierge: MailConcierge;
}): ConnectorDef {
    return {
        id: 'mail',
        name: 'Courrier',
        description:
            'Mails importants Gmail et, si le tri est actif, le concierge (labels Yui/…, actions à traiter, doutes).',
        defaultEnabled: true,
        pollMinutes: 15,
        settings: [
            {
                key: 'pollMinutes',
                label: 'Intervalle (min)',
                type: 'number',
                default: 15,
            },
            {
                key: 'query',
                label: 'Requête Gmail (importants)',
                type: 'string',
                default: DEFAULT_MAIL_QUERY,
            },
            {
                key: 'triage',
                label: 'Tri concierge (labels Yui/…)',
                type: 'boolean',
                default: false,
            },
            {
                key: 'maxPerHour',
                label: 'Max événements / heure',
                type: 'number',
                default: 6,
            },
        ],
        async events(ctx): Promise<Event[]> {
            const now = ctx.now();
            const out: Event[] = [];
            if (ctx.settings.triage !== true) {
                const query = String(ctx.settings.query ?? DEFAULT_MAIL_QUERY);
                const pollMinutes = Number(ctx.settings.pollMinutes ?? 15);
                for (const c of await evaluateMail(ctx.callTool, {
                    pollMinutes,
                    query,
                })) {
                    const e = fromCandidate(c, now);
                    out.push({
                        ...e,
                        importance: capLegacyImportance(e.importance),
                    });
                }
                return out;
            }

            const { concierge } = services;
            await concierge.scan();
            const signaled = new Set(ctx.state.get<string[]>('signaled', []));
            const today = localDay(now);
            let urgentDay = ctx.state.get<string>('urgentDay', '');
            let urgentCount = ctx.state.get<number>('urgentCount', 0);
            if (urgentDay !== today) {
                urgentDay = today;
                urgentCount = 0;
            }
            for (const p of concierge.getState().proposals) {
                const relevant =
                    p.category === 'action' ||
                    (p.urgency && p.urgency !== 'none');
                if (!relevant || signaled.has(p.mailId)) continue;
                signaled.add(p.mailId);

                let importance: Importance = 'utile';
                const facts = [
                    `Classé « ${p.category} » ${
                        VIA_LABEL[p.via] ?? VIA_LABEL.llm
                    }.`,
                ];
                if (isUrgentMail(p)) {
                    if (urgentCount < MAIL_URGENT_PER_DAY) {
                        importance = 'urgent';
                        urgentCount++;
                    } else {
                        facts.push('Urgence plafonnée pour aujourd’hui.');
                        ctx.log.info(
                            `mail: urgence plafonnée (${MAIL_URGENT_PER_DAY}/jour) pour ${p.mailId}`,
                        );
                    }
                }
                if (p.reason) facts.push(p.reason);

                out.push({
                    source: 'mail',
                    key: `mail-action-${p.mailId}`,
                    kind: 'request',
                    importance,
                    subject: `Mail à traiter — ${p.from} : « ${p.subject} »`
                        .replace(/\s+/g, ' ')
                        .slice(0, SUBJECT_MAX),
                    facts,
                    at: now,
                    ttlMs: ACTION_TTL_MS,
                    // Un mail à traiter devient un post-it ; l'id Gmail dans
                    // la description permet de retrouver le mail depuis Yoji.
                    todo: {
                        title: `Répondre : ${p.subject}`
                            .replace(/\s+/g, ' ')
                            .slice(0, TODO_TITLE_MAX),
                        description: (
                            `De ${p.from} — gmail:${p.mailId}` +
                            (p.reason ? ` — ${p.reason}` : '')
                        ).slice(0, TODO_DESCRIPTION_MAX),
                    },
                });
            }
            ctx.state.set('signaled', [...signaled].slice(-MAX_SIGNALED));
            ctx.state.set('urgentDay', urgentDay);
            ctx.state.set('urgentCount', urgentCount);

            // Les doutes ouverts s'accumulent : un seul événement récapitulatif,
            // le cooldown (3 h) faisant office d'anti-répétition.
            const doubts = concierge.openDoubts();
            if (doubts.length) {
                const sample = doubts
                    .slice(0, 2)
                    .map((d) => `« ${d.subject.slice(0, 50)} »`)
                    .join(', ');
                out.push({
                    source: 'mail',
                    key: 'mail-doubts',
                    kind: 'request',
                    importance: 'utile',
                    subject:
                        `Le concierge hésite sur ${doubts.length} mail(s) — à trancher dans la page Courrier`.slice(
                            0,
                            SUBJECT_MAX,
                        ),
                    facts: [sample].filter(Boolean),
                    at: now,
                    cooldownMs: DOUBTS_COOLDOWN_MS,
                });
            }
            return out;
        },
        async snapshot(ctx): Promise<Fact[]> {
            const { concierge } = services;
            const st = concierge.getState();
            const actions = st.proposals
                .filter((p) => p.category === 'action')
                .slice(-MAX_SNAPSHOT_ACTIONS);
            const facts: Fact[] = [];
            if (ctx.settings.triage === true) {
                facts.push({
                    label: 'Courrier',
                    value: `${concierge.pending().length} à trier, ${
                        concierge.openDoubts().length
                    } doute(s)`,
                });
                const reading = concierge.readingCount();
                if (reading > 0) {
                    facts.push({
                        label: 'À lire',
                        value: `${reading} mail(s) à lire`,
                        key: 'mail-reading',
                    });
                }
            }
            for (const p of actions) {
                facts.push({
                    label: 'À traiter',
                    value: p.subject,
                    importance: 'utile',
                });
            }
            return facts;
        },
    };
}
