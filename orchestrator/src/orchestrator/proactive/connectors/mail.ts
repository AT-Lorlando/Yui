// Courrier : les mails « importants » Gmail (evaluateMail) et, si le réglage
// `triage` est actif, le concierge (règles → LLM → labels) dont les
// propositions « action » et les doutes deviennent des événements. Le tri
// n'a plus de timer à part : c'est le poll de ce connecteur.
import { evaluateMail } from '../watchers/mail';
import { fromCandidate, SUBJECT_MAX } from '../events';
import type { Event, Fact } from '../events';
import type { ConnectorDef } from '../connector';
import type { MailConcierge } from '../mail/concierge';

export const DEFAULT_MAIL_QUERY = 'is:important is:unread newer_than:1d';
const DOUBTS_COOLDOWN_MS = 3 * 3600_000;
/** Un mail à traiter reste pertinent une semaine. */
const ACTION_TTL_MS = 7 * 24 * 3600_000;
/** Ids déjà signalés gardés en mémoire — borne la taille de l'état. */
const MAX_SIGNALED = 500;
/** Sujets « à traiter » exposés au journal de situation. */
const MAX_SNAPSHOT_ACTIONS = 5;

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
            const query = String(ctx.settings.query ?? DEFAULT_MAIL_QUERY);
            const pollMinutes = Number(ctx.settings.pollMinutes ?? 15);
            for (const c of await evaluateMail(ctx.callTool, {
                pollMinutes,
                query,
            })) {
                out.push(fromCandidate(c, now));
            }
            if (ctx.settings.triage !== true) return out;

            const { concierge } = services;
            await concierge.scan();
            const signaled = new Set(ctx.state.get<string[]>('signaled', []));
            for (const p of concierge.getState().proposals) {
                if (p.category !== 'action' || signaled.has(p.mailId)) continue;
                signaled.add(p.mailId);
                out.push({
                    source: 'mail',
                    key: `mail-action-${p.mailId}`,
                    kind: 'request',
                    importance: 'utile',
                    subject: `Mail à traiter — ${p.from} : « ${p.subject} »`
                        .replace(/\s+/g, ' ')
                        .slice(0, SUBJECT_MAX),
                    facts: [
                        `Classé « ${p.category} » ${
                            p.via === 'rule'
                                ? 'par une règle apprise'
                                : 'par le concierge'
                        }.`,
                    ],
                    at: now,
                    ttlMs: ACTION_TTL_MS,
                });
            }
            ctx.state.set('signaled', [...signaled].slice(-MAX_SIGNALED));

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
