// Courrier v3 : le facteur (MailCourier) range et fait lire chaque mail au
// poll de ce connecteur, puis balaie les osef une fois par jour. Ce qui est
// « à prévenir » est déjà parti tout de suite par le moteur (notifyMail,
// plafonné par jour) — c'est LE canal d'alerte : le connecteur en fait un
// événement `request` toujours `utile` (post-it Yoji, matière du prochain
// point), jamais `urgent`, pour que le juge ne pousse pas une seconde fois.
// Les faits d'un mail lu sans alerte et les ordres satisfaits deviennent des
// événements `info`, retenus sans juge pour le prochain point.
//
// `events()` n'attend JAMAIS le scan : il vide d'abord les files (remplies
// par le scan PRÉCÉDENT), puis relance scan + balayage en arrière-plan. Un
// scan (Gmail + lecteur IA) peut dépasser le délai du runner
// (POLL_TIMEOUT_MS) : attendu ici, son dépassement jetterait les avis déjà
// vidés. Conséquence assumée : les avis d'un scan sortent au poll SUIVANT
// (la sortie immédiate, elle, part déjà de notifyMail).
import {
    SUBJECT_MAX,
    TODO_TITLE_MAX,
    TODO_DESCRIPTION_MAX,
    FACTS_MAX_LINES,
    FACT_MAX_CHARS,
} from '../events';
import type { Event, Fact } from '../events';
import type { ConnectorDef } from '../connector';
import Logger from '../../../logger';
import type { ReaderItem } from '../mail/reader';
import type { MailOrder } from '../mail/orders';

const DAY_MS = 86_400_000;
/** Un mail signalé reste pertinent une semaine. */
const NOTIFY_TTL_MS = 7 * DAY_MS;
/** Les faits d'un mail lu valent trois jours. */
const INFO_TTL_MS = 3 * DAY_MS;
/** Ordres actifs exposés au journal de situation. */
const MAX_SNAPSHOT_ORDERS = 5;

/** Un mail lu par le lecteur IA, relayé par le moteur au connecteur. */
export interface MailNotice {
    mailId: string;
    from: string;
    subject: string;
    box?: string;
    item: ReaderItem;
    /** Sortie immédiate refusée par le plafond quotidien du moteur. */
    capped?: boolean;
}

/** Mail qui a satisfait un ordre de lecture. */
export interface FulfilledNotice extends MailNotice {
    order: { id: string; text: string };
}

export const NOTIFY_CAPPED_FACT = "Notification plafonnée pour aujourd'hui";

export interface MailConnectorServices {
    courier: {
        scan(): Promise<unknown>;
        sweep(): Promise<number>;
        unknown(): Array<{ address: string }>;
    };
    orders: { active(now: number): MailOrder[] };
    /** Vide et rend la file des mails déjà signalés (notifyMail). */
    takeNotified(): MailNotice[];
    /** Vide et rend la file des faits de mails lus sans alerte. */
    takeFacts(): MailNotice[];
    /** Vide et rend la file des ordres satisfaits par le lecteur. */
    takeFulfilled(): FulfilledNotice[];
}

/** Nom affiché d'un expéditeur, sans l'adresse `<…>`. Pur. */
export function senderName(from: string): string {
    return (
        from
            .replace(/<[^>]*>/g, '')
            .replace(/"/g, '')
            .trim() || from
    );
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function clipFacts(facts: string[]): string[] {
    return facts
        .map((f) => oneLine(f).slice(0, FACT_MAX_CHARS))
        .filter(Boolean)
        .slice(0, FACTS_MAX_LINES);
}

export function mailConnector(services: MailConnectorServices): ConnectorDef {
    return {
        id: 'mail',
        name: 'Courrier',
        description:
            'Le facteur : range les mails selon les listes d’expéditeurs, fait lire les « à lire » par l’IA et prévient de ce qui compte.',
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
                key: 'maxPerHour',
                label: 'Max événements / heure',
                type: 'number',
                default: 6,
            },
        ],
        async events(ctx): Promise<Event[]> {
            const now = ctx.now();
            const out: Event[] = [];

            for (const n of services.takeNotified()) {
                const who = senderName(n.from);
                // Le plafond juste après la raison : jamais coupé par la borne
                // de 10 lignes.
                const facts = [
                    n.item.reason,
                    ...(n.capped ? [NOTIFY_CAPPED_FACT] : []),
                    ...n.item.facts,
                ];
                out.push({
                    source: 'mail',
                    key: `mail-notify-${n.mailId}`,
                    kind: 'request',
                    importance: 'utile',
                    subject: oneLine(`Mail — ${who} : « ${n.subject} »`).slice(
                        0,
                        SUBJECT_MAX,
                    ),
                    facts: clipFacts(facts),
                    at: now,
                    ttlMs: NOTIFY_TTL_MS,
                    // L'id Gmail dans la description permet de retrouver le
                    // mail depuis le post-it Yoji.
                    todo: {
                        title: oneLine(`Répondre : ${n.subject}`).slice(
                            0,
                            TODO_TITLE_MAX,
                        ),
                        description: (
                            `De ${n.from} — gmail:${n.mailId}` +
                            (n.item.reason ? ` — ${n.item.reason}` : '')
                        ).slice(0, TODO_DESCRIPTION_MAX),
                    },
                });
            }

            for (const n of services.takeFacts()) {
                const facts = clipFacts(n.item.facts);
                if (!facts.length) continue;
                out.push({
                    source: 'mail',
                    key: `mail-info-${n.mailId}`,
                    kind: 'info',
                    importance: 'info',
                    subject: oneLine(`Courrier : « ${n.subject} »`).slice(
                        0,
                        SUBJECT_MAX,
                    ),
                    facts,
                    at: now,
                    ttlMs: INFO_TTL_MS,
                });
            }

            for (const n of services.takeFulfilled()) {
                out.push({
                    source: 'mail',
                    key: `mail-order-${n.order.id}`,
                    kind: 'info',
                    importance: 'info',
                    subject: oneLine(`Ordre satisfait : ${n.order.text}`).slice(
                        0,
                        SUBJECT_MAX,
                    ),
                    facts: clipFacts([n.item.reason, ...n.item.facts]),
                    at: now,
                    ttlMs: INFO_TTL_MS,
                });
            }
            // scan unique (partagé avec POST /mail/scan), jamais attendu
            const { courier } = services;
            void courier
                .scan()
                .then(() => courier.sweep())
                .catch((e) =>
                    Logger.warn(`courrier : scan de fond en échec : ${e}`),
                );
            return out;
        },
        async snapshot(ctx): Promise<Fact[]> {
            const facts: Fact[] = [];
            const unknown = services.courier.unknown().length;
            if (unknown > 0) {
                facts.push({
                    label: 'Courrier',
                    value: `${unknown} expéditeur(s) inconnu(s)`,
                });
            }
            for (const o of services.orders
                .active(ctx.now())
                .slice(0, MAX_SNAPSHOT_ORDERS)) {
                facts.push({ label: 'J’attends', value: o.text });
            }
            return facts;
        },
    };
}
