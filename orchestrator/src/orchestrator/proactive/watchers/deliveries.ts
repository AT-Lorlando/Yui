import Logger from '../../../logger';
import type {
    CandidateEvent,
    DeliveriesWatcherConfig,
    ProactiveDeps,
    Watcher,
} from '../types';
import {
    detectParcels,
    extractEta,
    carrierFromSender,
} from '../../deliveries/carriers';
import type { ParcelStatus } from '../../deliveries/providers';
import {
    refreshFromCarriers,
    takeTransitions,
    upsertFromMail,
    type Transition,
} from '../../deliveries/tracker';

/**
 * Watcher livraisons — deux étages :
 *
 * 1. Mails de suivi (Amazon, Colis Privé, Colissimo, ASOS…) : classés par
 *    sujet/aperçu ; quand un numéro de suivi est extractible du corps, le
 *    colis rejoint le registre (`deliveries/tracker.ts`) avec transporteur,
 *    lien de suivi et date estimée.
 * 2. Registre : les providers transporteur (page Colis Privé, API La Poste
 *    si LAPOSTE_API_KEY) raffinent le statut entre deux mails.
 *
 * Les notifications sortent des TRANSITIONS de statut du registre (en
 * livraison / à retirer / problème → tout de suite ; expédié / livré →
 * digest). Un mail sans numéro exploitable notifie comme avant, dédupliqué
 * par sujet.
 */

// Expéditeurs de suivi usuels + sujets « colis » — surchargable via
// proactive.json (deliveries.query).
export const DEFAULT_DELIVERIES_QUERY =
    'newer_than:1d {from:amazon.fr from:colissimo.fr from:laposte.fr ' +
    'from:chronopost.fr from:mondialrelay.fr from:dhl.com from:ups.com ' +
    'from:relaiscolis.com from:vinted.fr from:colisprive.com ' +
    'from:colisprive.fr from:asos.com from:dpd.fr from:gls-group.eu ' +
    'subject:colis subject:livraison}';

const DEDUP_MS = 48 * 60 * 60_000;
/** Corps de mails lus par tick (coût API Gmail). */
const MAX_BODY_FETCH = 5;

export type DeliveryKind = 'arriving' | 'pickup' | 'delivered' | 'shipped';

// L'ordre compte : « sera livrée aujourd'hui » doit matcher arriving,
// pas delivered.
const KIND_PATTERNS: [DeliveryKind, RegExp][] = [
    [
        'arriving',
        /arrive aujourd'hui|arrivera aujourd'hui|en cours de livraison|en cours de distribution|out for delivery|sera livr[ée]e? aujourd'hui|livraison pr[ée]vue aujourd'hui|votre livreur|arrive bient[oô]t/i,
    ],
    [
        'pickup',
        /point relais|point de retrait|bureau de poste|[àa] retirer|est arriv[ée] dans votre|pr[êe]t [àa] [êe]tre retir[ée]|disponible en (?:point|relais|magasin)/i,
    ],
    // « Livré : « X » » est le format réel des sujets Amazon.
    [
        'delivered',
        /a [ée]t[ée] livr[ée]|livr[ée]e? :|delivered|a [ée]t[ée] d[ée]pos[ée]|remis en main/i,
    ],
    [
        'shipped',
        /exp[ée]di[ée]|en transit|shipped|a [ée]t[ée] envoy[ée]|est en route|en chemin|nous avons un colis pour vous/i,
    ],
];

const KIND_STATUS: Record<DeliveryKind, ParcelStatus> = {
    arriving: 'out_for_delivery',
    pickup: 'pickup_ready',
    delivered: 'delivered',
    shipped: 'shipped',
};

const KIND_LABEL: Record<DeliveryKind, string> = {
    arriving: 'en cours de livraison',
    pickup: 'à retirer',
    delivered: 'livré',
    shipped: 'expédié',
};

const STATUS_LABEL: Record<ParcelStatus, string> = {
    announced: 'annoncé',
    shipped: 'expédié',
    in_transit: 'en transit',
    out_for_delivery: 'en cours de livraison',
    pickup_ready: 'à retirer en point de retrait',
    delivered: 'livré',
    problem: 'en difficulté (incident de livraison)',
};

const IMMEDIATE: ParcelStatus[] = [
    'out_for_delivery',
    'pickup_ready',
    'problem',
];

export interface ParsedMail {
    id: string;
    from: string;
    subject: string;
    snippet: string;
}

/** Découpe la sortie texte de search_emails. */
export function parseSearchOutput(text: string): ParsedMail[] {
    return text
        .split(/\n---\n/)
        .map((block) => ({
            id: /^ID: (\S+)$/m.exec(block)?.[1] ?? '',
            from: /^De: (.+)$/m.exec(block)?.[1]?.trim() ?? '',
            subject: /^Objet: (.+)$/m.exec(block)?.[1]?.trim() ?? '',
            snippet: /^Apercu: (.+)$/m.exec(block)?.[1]?.trim() ?? '',
        }))
        .filter((m) => m.subject);
}

export function classifyDelivery(mail: {
    subject: string;
    snippet: string;
}): DeliveryKind | null {
    const text = `${mail.subject} ${mail.snippet}`;
    for (const [kind, re] of KIND_PATTERNS) {
        if (re.test(text)) return kind;
    }
    return null;
}

/** Nom lisible de l'expéditeur ("Amazon.fr <ship@amazon.fr>" → "Amazon.fr"). */
function senderName(from: string): string {
    return (from.split('<')[0].trim() || from).replace(/^"|"$/g, '');
}

/** Hash djb2 → clé de dédup stable par sujet de mail. */
function slug(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

/** Candidat "legacy" pour un mail dont aucun numéro n'est extractible. */
export function mailOnlyCandidate(
    mail: ParsedMail,
    kind: DeliveryKind,
): CandidateEvent {
    const snippet = mail.snippet
        .replace(/[͏​-‍⁠﻿]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // Le sujet Gmail utilise des espaces insécables, l'aperçu des espaces
    // normales — normaliser avant de comparer.
    const normSubject = mail.subject.replace(/\s+/g, ' ');
    const extra =
        snippet && !snippet.startsWith(normSubject.slice(0, 30))
            ? ` (${snippet.slice(0, 160)})`
            : '';
    return {
        watcherId: 'deliveries',
        subject: `livraison-${kind}-${slug(mail.subject)}`,
        importance: IMMEDIATE.includes(KIND_STATUS[kind]) ? 'utile' : 'info',
        facts:
            `Colis ${KIND_LABEL[kind]} — ${senderName(mail.from)} : ` +
            `« ${mail.subject} »${extra}`,
        cooldownMs: DEDUP_MS,
    };
}

/** Transition de statut d'un colis suivi → candidat. Pur. */
export function transitionCandidate(t: Transition): CandidateEvent {
    const p = t.parcel;
    const who = p.label ? `${p.label} (${p.carrier})` : p.carrier;
    const eta =
        p.estimatedDate && t.to !== 'delivered'
            ? `, livraison estimée le ${p.estimatedDate}`
            : '';
    const lastEvent = p.events[0]?.label ? ` — ${p.events[0].label}` : '';
    return {
        watcherId: 'deliveries',
        subject: `livraison-${p.id}-${t.to}`,
        importance: IMMEDIATE.includes(t.to) ? 'utile' : 'info',
        facts: `Colis ${who}, n° ${p.tracking} : ${
            STATUS_LABEL[t.to]
        }${eta}${lastEvent}`,
        cooldownMs: DEDUP_MS,
    };
}

export async function evaluateDeliveries(
    deviceHandler: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>,
    cfg: DeliveriesWatcherConfig,
): Promise<CandidateEvent[]> {
    const events: CandidateEvent[] = [];

    // 1. Mails du jour → classification + extraction de numéros.
    const result = await deviceHandler('search_emails', {
        query: cfg.query || DEFAULT_DELIVERIES_QUERY,
        maxResults: 15,
    });
    if (typeof result === 'string' && !result.startsWith('Aucun email')) {
        let bodiesFetched = 0;
        for (const mail of parseSearchOutput(result)) {
            const kind = classifyDelivery(mail);
            if (!kind) continue;
            let detected = detectParcels(
                `${mail.subject} ${mail.snippet}`,
                mail.from,
            );
            // L'aperçu suffit rarement — aller chercher le corps complet.
            let body = '';
            if (!detected.length && mail.id && bodiesFetched < MAX_BODY_FETCH) {
                bodiesFetched++;
                const full = await deviceHandler('get_email', {
                    messageId: mail.id,
                }).catch(() => '');
                if (typeof full === 'string') {
                    body = full;
                    detected = detectParcels(full, mail.from);
                }
            }
            if (detected.length) {
                const eta = extractEta(
                    `${mail.subject} ${mail.snippet} ${body}`,
                    new Date(),
                );
                for (const parcel of detected) {
                    upsertFromMail(parcel, {
                        status: KIND_STATUS[kind],
                        label: senderName(mail.from),
                        estimatedDate: eta,
                    });
                }
            } else {
                events.push(mailOnlyCandidate(mail, kind));
            }
        }
    }

    // 2. Providers transporteur pour les colis actifs du registre.
    await refreshFromCarriers();

    // 3. Toutes les transitions (mails, providers, ajouts manuels) notifient.
    for (const t of takeTransitions()) events.push(transitionCandidate(t));

    return events;
}

export function createDeliveriesWatcher(
    cfg: DeliveriesWatcherConfig,
    deps: ProactiveDeps,
): Watcher {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = async (emit: (c: CandidateEvent) => void): Promise<void> => {
        try {
            const events = await evaluateDeliveries(deps.deviceHandler, cfg);
            Logger.info(
                `proactive[deliveries]: poll → ${events.length} candidat(s)`,
            );
            for (const e of events) emit(e);
        } catch (err) {
            Logger.warn(`proactive[deliveries]: ${err}`);
        }
    };
    return {
        id: 'deliveries',
        start(emit) {
            void tick(emit);
            timer = setInterval(
                () => void tick(emit),
                cfg.pollMinutes * 60_000,
            );
        },
        stop() {
            if (timer) clearInterval(timer);
        },
    };
}

/** Rétro-compat : évaluation sur texte seul (mails sans registre). */
export function evaluateDeliveriesText(text: string): CandidateEvent[] {
    const events: CandidateEvent[] = [];
    for (const mail of parseSearchOutput(text)) {
        const kind = classifyDelivery(mail);
        if (kind) events.push(mailOnlyCandidate(mail, kind));
    }
    return events;
}
