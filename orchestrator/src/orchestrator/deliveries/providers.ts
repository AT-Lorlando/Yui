import Logger from '../../logger';
import type { Carrier } from './carriers';

/**
 * Providers de suivi transporteur — interrogent l'état d'un colis à la
 * source, entre deux mails.
 *
 * - Colis Privé : la page publique DetailColis.aspx (HTML server-rendered,
 *   pas d'API ni de clé) — l'URL vient du mail (numColis = numéro + code
 *   postal du destinataire).
 * - La Poste (Colissimo/Chronopost) : API Okapi « Suivi v2 », clé gratuite
 *   sur developer.laposte.fr → env LAPOSTE_API_KEY. Sans clé, le provider
 *   est simplement inactif (les mails continuent de faire foi).
 *
 * Les parseurs sont purs et testés ; le fetch est isolé.
 */

export type ParcelStatus =
    | 'announced'
    | 'shipped'
    | 'in_transit'
    | 'out_for_delivery'
    | 'pickup_ready'
    | 'delivered'
    | 'problem';

export interface ProviderUpdate {
    status: ParcelStatus;
    /** Événements du plus récent au plus ancien. */
    events: { date: string; label: string }[];
    estimatedDate?: string;
    sender?: string;
}

/** Libellé Colis Privé → statut. Pur. */
export function statusFromColisPriveLabel(label: string): ParcelStatus {
    const l = label.toLowerCase();
    if (/livr[ée] (?:le|à|dans|en)|a [ée]t[ée] livr[ée]/.test(l)) {
        return 'delivered';
    }
    if (/en cours de distribution|par le livreur/.test(l)) {
        return 'out_for_delivery';
    }
    if (/relais|point de retrait|à retirer/.test(l)) return 'pickup_ready';
    if (/incident|retour|non distribu|absent|échec/.test(l)) return 'problem';
    if (/pris en charge|agence|exp[ée]di[ée]|acheminement|transit/.test(l)) {
        return 'in_transit';
    }
    if (/pr[ée]paration/.test(l)) return 'announced';
    return 'in_transit';
}

/** Parse la page DetailColis.aspx (HTML brut). Pur. */
export function parseColisPrivePage(html: string): ProviderUpdate | null {
    const text = html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ');
    const status = /Statut\s+(.+?)\s+Adresse du destinataire/.exec(text)?.[1];
    if (!status) return null;
    const sender = /exp[ée]di[ée] par\s+([A-Z0-9&' .-]+?)\s+N° de colis/i.exec(
        text,
    )?.[1];
    const events: { date: string; label: string }[] = [];
    const histRe =
        /(\d{2}\/\d{2}\/\d{4})\s+(.+?)(?=\s+\d{2}\/\d{2}\/\d{4}|\s+Définir|\s*$)/g;
    const hist = /Statut du colis([\s\S]*)/.exec(text)?.[1] ?? '';
    let m;
    while ((m = histRe.exec(hist))) {
        events.push({ date: m[1], label: m[2].trim() });
    }
    return {
        status: statusFromColisPriveLabel(status),
        events,
        sender: sender?.trim(),
    };
}

/** Code événement Okapi (La Poste) → statut. Pur. */
export function statusFromOkapiCode(code: string): ParcelStatus {
    if (/^DI/.test(code)) return 'delivered';
    if (code === 'MD2') return 'out_for_delivery';
    if (/^(AG|RE)/.test(code)) return 'pickup_ready';
    if (/^(ND|PB|AN)/.test(code)) return 'problem';
    if (/^(PC|DR)/.test(code)) return 'shipped';
    return 'in_transit';
}

/** Parse la réponse JSON Okapi Suivi v2. Pur. */
export function parseOkapiResponse(raw: unknown): ProviderUpdate | null {
    const shipment = (raw as { shipment?: Record<string, unknown> })?.shipment;
    if (!shipment) return null;
    const rawEvents = Array.isArray(shipment.event)
        ? (shipment.event as { date?: string; label?: string; code?: string }[])
        : [];
    if (!rawEvents.length) return null;
    // Okapi donne les événements du plus ancien au plus récent.
    const events = rawEvents
        .map((e) => ({
            date: (e.date ?? '').slice(0, 10),
            label: e.label ?? '',
            code: e.code ?? '',
        }))
        .reverse();
    const estim =
        typeof shipment.estimDate === 'string' && shipment.estimDate
            ? shipment.estimDate.slice(0, 10)
            : undefined;
    return {
        status: statusFromOkapiCode(events[0].code),
        events: events.map(({ date, label }) => ({ date, label })),
        estimatedDate: estim,
    };
}

// ── Fetchers ────────────────────────────────────────────────────────────────

const UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchColisPrive(url: string): Promise<ProviderUpdate | null> {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Colis Privé HTTP ${res.status}`);
    return parseColisPrivePage(await res.text());
}

async function fetchLaPoste(tracking: string): Promise<ProviderUpdate | null> {
    const key = process.env.LAPOSTE_API_KEY;
    if (!key) return null;
    const res = await fetch(
        `https://api.laposte.fr/suivi/v2/idships/${encodeURIComponent(
            tracking,
        )}?lang=fr_FR`,
        {
            headers: { 'X-Okapi-Key': key, Accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
        },
    );
    if (res.status === 404) return null; // numéro inconnu (encore)
    if (!res.ok) throw new Error(`Okapi HTTP ${res.status}`);
    return parseOkapiResponse(await res.json());
}

/**
 * Interroge le transporteur pour un colis. Renvoie null si aucun provider
 * ne couvre ce transporteur (ou clé absente) — jamais d'exception.
 */
export async function queryCarrier(
    carrier: Carrier,
    tracking: string,
    url?: string,
): Promise<ProviderUpdate | null> {
    try {
        // Sans URL (ajout manuel), la page se reconstruit avec le code
        // postal du foyer : numColis = numéro + code postal.
        if (carrier === 'colisprive' && !url) {
            const cp = process.env.DELIVERIES_POSTAL_CODE;
            if (cp && /^\d{12}$/.test(tracking)) {
                url = `https://www.colisprive.com/moncolis/pages/DetailColis.aspx?numColis=${tracking}${cp}`;
            }
        }
        if (carrier === 'colisprive' && url) return await fetchColisPrive(url);
        if (carrier === 'colissimo' || carrier === 'chronopost') {
            return await fetchLaPoste(tracking);
        }
    } catch (e) {
        Logger.warn(`deliveries: ${carrier} ${tracking} — ${e}`);
    }
    return null;
}
