/**
 * Détection transporteur + numéro de suivi dans le texte d'un mail.
 * Pur (pas d'I/O) — tout est testé dans carriers.test.ts.
 */

export type Carrier =
    | 'colisprive'
    | 'colissimo'
    | 'chronopost'
    | 'mondialrelay'
    | 'ups'
    | 'dhl'
    | 'dpd'
    | 'gls'
    | 'amazon'
    | 'inconnu';

export interface DetectedParcel {
    tracking: string;
    carrier: Carrier;
    /** Lien de suivi trouvé dans le mail (page publique du transporteur). */
    url?: string;
}

/** Transporteur déduit de l'expéditeur du mail (domaine ou nom). */
export function carrierFromSender(from: string): Carrier | null {
    const f = from.toLowerCase();
    if (f.includes('colisprive') || f.includes('colis prive')) {
        return 'colisprive';
    }
    if (f.includes('colissimo')) return 'colissimo';
    if (f.includes('laposte')) return 'colissimo';
    if (f.includes('chronopost')) return 'chronopost';
    if (f.includes('mondialrelay') || f.includes('mondial relay')) {
        return 'mondialrelay';
    }
    if (f.includes('ups.com')) return 'ups';
    if (f.includes('dhl')) return 'dhl';
    if (f.includes('dpd')) return 'dpd';
    if (f.includes('gls')) return 'gls';
    if (f.includes('amazon')) return 'amazon';
    return null;
}

// URLs de suivi reconnues — chacune donne transporteur + numéro fiables.
const URL_PATTERNS: [Carrier, RegExp][] = [
    // numColis = numéro (12) + code postal (5)
    [
        'colisprive',
        /https:\/\/www\.colisprive\.com\/moncolis\/pages\/DetailColis\.aspx\?numColis=(\d{17})/i,
    ],
    [
        'colissimo',
        /https:\/\/www\.laposte\.fr\/outils\/suivre-vos-envois\?code=([A-Z0-9]{10,15})/i,
    ],
    [
        'chronopost',
        /https:\/\/www\.chronopost\.fr\/tracking[^\s"']*?(?:listeNumeros|reference)=([A-Z0-9]{10,15})/i,
    ],
];

// Formats de numéros par transporteur (sur texte sans espaces).
const NUMBER_PATTERNS: [Carrier, RegExp][] = [
    ['ups', /\b1Z[A-Z0-9]{16}\b/],
    // S10 international (RR123456789FR) — Colissimo/Chronopost
    ['colissimo', /\b[A-Z]{2}\d{9}FR\b/],
    // Colissimo national : 5-9 + lettre + 11 chiffres
    ['colissimo', /\b[5-9][A-Z]\d{11}\b/],
    ['chronopost', /\b[A-Z]{2}\d{9}[A-Z]{2}\b/],
];

/**
 * Extrait les colis (numéro + transporteur) d'un texte de mail.
 * `senderHint` (l'expéditeur) départage les formats ambigus — les numéros
 * « 12 chiffres » ne sont acceptés qu'avec un transporteur connu.
 */
export function detectParcels(text: string, senderHint = ''): DetectedParcel[] {
    const found = new Map<string, DetectedParcel>();
    const add = (p: DetectedParcel) => {
        if (!found.has(p.tracking)) found.set(p.tracking, p);
    };

    // 1. URLs de suivi — la source la plus fiable.
    for (const [carrier, re] of URL_PATTERNS) {
        const m = re.exec(text);
        if (!m) continue;
        const tracking =
            carrier === 'colisprive' ? m[1].slice(0, 12) : m[1].toUpperCase();
        add({ tracking, carrier, url: m[0] });
    }

    // 2. Formats de numéros non ambigus.
    const flat = text.replace(/[ \s]+/g, ' ');
    const noSpaces = flat.replace(/(\d) (?=\d)/g, '$1');
    for (const [carrier, re] of NUMBER_PATTERNS) {
        const m = re.exec(noSpaces);
        if (m) add({ tracking: m[0], carrier });
    }

    // 3. 12 chiffres (éventuellement groupés par 3) près du mot « colis »,
    //    seulement si l'expéditeur est identifié (Colis Privé, Mondial Relay…).
    const sender = carrierFromSender(senderHint);
    if (sender && sender !== 'amazon') {
        const near = /colis[^\d]{0,40}((?:\d[\s ]?){8,14}\d)/i.exec(flat);
        if (near) {
            const tracking = near[1].replace(/\D/g, '');
            if (tracking.length >= 8 && tracking.length <= 15) {
                add({ tracking, carrier: sender });
            }
        }
    }

    return [...found.values()];
}

/** « livré aujourd'hui / demain / le 08/09 » → date ISO (YYYY-MM-DD). */
export function extractEta(text: string, now: Date): string | undefined {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const t = text.toLowerCase();
    if (/livr[ée][^.]{0,30}aujourd'hui|aujourd'hui[^.]{0,30}livr/i.test(t)) {
        return iso(now);
    }
    if (/livr[ée][^.]{0,30}demain|demain[^.]{0,30}livr/i.test(t)) {
        return iso(new Date(now.getTime() + 86_400_000));
    }
    const m =
        /livraison(?:\s+(?:est\s+)?(?:pr[ée]vue|estim[ée]e))?[^.\d]{0,30}le\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i.exec(
            t,
        );
    if (m) {
        const year = m[3]
            ? Number(m[3].length === 2 ? `20${m[3]}` : m[3])
            : now.getFullYear();
        const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
        // Sans année : si la date est passée de > 2 mois, c'est l'an prochain.
        if (!m[3] && d.getTime() < now.getTime() - 60 * 86_400_000) {
            d.setUTCFullYear(year + 1);
        }
        return iso(d);
    }
    return undefined;
}
