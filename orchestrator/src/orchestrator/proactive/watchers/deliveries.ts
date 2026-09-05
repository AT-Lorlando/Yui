import Logger from '../../../logger';
import type {
    CandidateEvent,
    DeliveriesWatcherConfig,
    ProactiveDeps,
    Watcher,
} from '../types';

/**
 * Watcher livraisons — repère les mails de suivi de colis (Amazon,
 * Colissimo, Chronopost, Mondial Relay, DHL, UPS, Vinted…) et signale au bon
 * moment : « en cours de livraison / arrive aujourd'hui » et « à retirer en
 * point relais » tout de suite, « expédié » et « livré » dans le digest.
 *
 * Tout repose sur les mails (pas d'API transporteur) : la requête Gmail est
 * bornée à 1 jour, la dédup se fait par sujet de mail (48 h) — un même mail
 * ne notifie qu'une fois, un nouveau mail du transporteur re-signale.
 */

// Expéditeurs de suivi usuels — surchargables via proactive.json.
export const DEFAULT_DELIVERIES_QUERY =
    'newer_than:1d {from:amazon.fr from:colissimo.fr from:laposte.fr ' +
    'from:chronopost.fr from:mondialrelay.fr from:dhl.com from:ups.com ' +
    'from:relaiscolis.com from:vinted.fr}';

const DEDUP_MS = 48 * 60 * 60_000;

export type DeliveryKind = 'arriving' | 'pickup' | 'delivered' | 'shipped';

// L'ordre compte : « sera livré aujourd'hui » doit matcher arriving,
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
    ['shipped', /exp[ée]di[ée]|en transit|shipped|a [ée]t[ée] envoy[ée]/i],
];

const KIND_LABEL: Record<DeliveryKind, string> = {
    arriving: 'en cours de livraison',
    pickup: 'à retirer',
    delivered: 'livré',
    shipped: 'expédié',
};

interface ParsedMail {
    from: string;
    subject: string;
    snippet: string;
}

/** Découpe la sortie texte de search_emails en mails {from, subject, snippet}. */
export function parseSearchOutput(text: string): ParsedMail[] {
    return text
        .split(/\n---\n/)
        .map((block) => ({
            from: /^De: (.+)$/m.exec(block)?.[1]?.trim() ?? '',
            subject: /^Objet: (.+)$/m.exec(block)?.[1]?.trim() ?? '',
            snippet: /^Apercu: (.+)$/m.exec(block)?.[1]?.trim() ?? '',
        }))
        .filter((m) => m.subject);
}

export function classifyDelivery(mail: ParsedMail): DeliveryKind | null {
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

/** Transforme la sortie de search_emails en candidats. Pur, testé. */
export function evaluateDeliveriesText(text: string): CandidateEvent[] {
    const events: CandidateEvent[] = [];
    for (const mail of parseSearchOutput(text)) {
        const kind = classifyDelivery(mail);
        if (!kind) continue;
        const immediate = kind === 'arriving' || kind === 'pickup';
        // Les aperçus Gmail traînent des caractères invisibles (U+034F,
        // zero-width…) et répètent souvent le sujet — on nettoie.
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
        events.push({
            watcherId: 'deliveries',
            subject: `livraison-${kind}-${slug(mail.subject)}`,
            importance: immediate ? 'utile' : 'info',
            facts:
                `Colis ${KIND_LABEL[kind]} — ${senderName(mail.from)} : ` +
                `« ${mail.subject} »${extra}`,
            cooldownMs: DEDUP_MS,
        });
    }
    return events;
}

export async function evaluateDeliveries(
    deviceHandler: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>,
    cfg: DeliveriesWatcherConfig,
): Promise<CandidateEvent[]> {
    const result = await deviceHandler('search_emails', {
        query: cfg.query || DEFAULT_DELIVERIES_QUERY,
        maxResults: 15,
    });
    if (typeof result !== 'string' || result.startsWith('Aucun email')) {
        return [];
    }
    return evaluateDeliveriesText(result);
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
