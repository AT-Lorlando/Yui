import Logger from '../../logger';
import { listParcels, setContent, type Parcel } from './tracker';

/**
 * Corrélation colis ↔ contenu : retrouver CE QU'IL Y A DEDANS à partir des
 * mails du marchand.
 *
 * Il n'y a pas de clé de jointure exacte (vérifié : ni Amazon ni ASOS ne
 * mettent le numéro transporteur dans leurs mails), donc trois étages :
 *
 * 1. **Sûr** — le numéro de suivi apparaît dans le corps d'un mail marchand
 *    (rare mais imparable).
 * 2. **Probable, déterministe** — un seul mail d'expédition non encore
 *    apparié dans la fenêtre de dates → c'est lui.
 * 3. **Probable, LLM** — plusieurs candidats : un petit appel LLM tranche
 *    (et sait lire un corps de mail pour les marchands qui ne mettent pas
 *    les articles dans le sujet, comme ASOS).
 *
 * Amazon met les articles dans ses sujets (« Expédié : "X" », « Expédié :
 * 2 "Y" ») — l'extraction par sujet couvre le gros des cas sans LLM.
 */

export interface ContentMatch {
    content: string;
    confidence: 'sûr' | 'probable';
    mailId: string;
}

export interface CandidateMail {
    id: string;
    subject: string;
    /** Âge approximatif en jours (déduit du champ Date relatif de Gmail). */
    ageDays: number;
    items: string | null;
}

/** Noms qui ne sont QUE des transporteurs (pas des marchands). Pur. */
export function isPureCarrierName(label: string): boolean {
    return /colis\s?priv|colissimo|chronopost|mondial\s?relay|la\s?poste|^(ups|dhl|dpd|gls)\b/i.test(
        label,
    );
}

/** « Expédié : 2 "SheaMoisture..." » → « 2× SheaMoisture… ». Pur. */
export function extractItemsFromSubject(subject: string): string | null {
    const m =
        /^(?:exp[ée]di[ée]e?|livr[ée]e?)\s*:\s*(\d+\s+)?[«"]\s*(.+?)\s*[»"]/i.exec(
            subject.trim(),
        );
    if (!m) return null;
    const count = m[1] ? `${m[1].trim()}× ` : '';
    const title = m[2].replace(/,?\s*\.{3}$/, '…').trim();
    return `${count}${title}`;
}

/** « il y a 2h » → 0, « hier » → 1, « il y a 3 jours » → 3. Pur. */
export function ageFromRelativeDate(date: string): number {
    const d = date.toLowerCase();
    if (/il y a \d+\s*(h|min)/.test(d) || d.includes("aujourd'hui")) return 0;
    if (d.includes('hier')) return 1;
    const m = /il y a (\d+)\s*jour/.exec(d);
    if (m) return Number(m[1]);
    const abs = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(d);
    if (abs) {
        const then = Date.UTC(
            Number(abs[3]),
            Number(abs[2]) - 1,
            Number(abs[1]),
        );
        return Math.max(0, Math.round((Date.now() - then) / 86_400_000));
    }
    return 99;
}

/** Sujets qui parlent d'une expédition (pas d'avis, pas de promo). Pur. */
export function isShipmentSubject(subject: string): boolean {
    return /exp[ée]di[ée]|exp[ée]dition|en route|commande|livr[ée]|colis/i.test(
        subject,
    );
}

const SEARCH_BLOCK = /ID: (\S+)\nDe: .+\nObjet: (.+)\nDate: (.+)\nLu:/g;

function parseCandidates(
    searchOutput: string,
    claimed: Set<string>,
): CandidateMail[] {
    const out: CandidateMail[] = [];
    let m;
    while ((m = SEARCH_BLOCK.exec(searchOutput))) {
        const [, id, subject, date] = m;
        if (claimed.has(id) || !isShipmentSubject(subject)) continue;
        out.push({
            id,
            subject: subject.trim(),
            ageDays: ageFromRelativeDate(date),
            items: extractItemsFromSubject(subject),
        });
    }
    return out;
}

/** Fenêtre de dates : le mail d'expédition précède la création du colis
 *  de 0 à 4 jours (le mail transporteur suit l'expédition marchande). Pur. */
export function inDateWindow(c: CandidateMail, parcelAgeDays: number): boolean {
    const delta = c.ageDays - parcelAgeDays;
    return delta >= -1 && delta <= 4;
}

/**
 * Règle des dates de livraison. Un mail marchand « Livré : X » daté d'un
 * autre jour que la livraison de CE colis prouve que X appartient à un
 * autre colis → on écarte X (son « Expédié » compris). Inversement, un
 * « Livré : X » du même jour que la livraison du colis est le match — on
 * ne garde que lui. Pur.
 */
export function resolveByDeliveryDate(
    candidates: CandidateMail[],
    deliveredAge: number | null,
): CandidateMail[] {
    const deliveredMails = candidates.filter(
        (c) => /^livr/i.test(c.subject) && c.items,
    );
    const excludedItems = new Set<string>();
    for (const d of deliveredMails) {
        if (deliveredAge !== null && d.ageDays === deliveredAge) {
            return [d];
        }
        excludedItems.add(d.items!);
    }
    return candidates.filter((c) => !c.items || !excludedItems.has(c.items));
}

function stripHtml(body: string): string {
    return body
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 3_000);
}

type DeviceHandler = (
    tool: string,
    args?: Record<string, unknown>,
) => Promise<unknown>;
type Complete = (system: string, user: string) => Promise<string>;

const LLM_SYSTEM =
    "Tu associes un colis à son contenu à partir de mails d'un marchand. " +
    'Réponds UNIQUEMENT un objet JSON de la forme ' +
    '{"choix": <numéro du mail ou null>, "articles": "<contenu du colis en quelques mots>"} ' +
    "— choix null si aucun mail ne correspond. Pas d'autre texte.";

async function llmPick(
    complete: Complete,
    parcel: Parcel,
    candidates: CandidateMail[],
    bodyOfFirst?: string,
): Promise<{ candidate: CandidateMail; items: string } | null> {
    const list = candidates
        .map(
            (c, i) =>
                `${i + 1}. « ${c.subject} » (il y a ${c.ageDays} jour(s))`,
        )
        .join('\n');
    const user =
        `Colis : expédié il y a ~${Math.round(
            (Date.now() - parcel.createdAt) / 86_400_000,
        )} jour(s)` +
        ` par ${parcel.label}, transporteur ${parcel.carrier}, statut ${parcel.status}.\n` +
        `Mails du marchand :\n${list}\n` +
        (bodyOfFirst ? `\nCorps du mail 1 :\n${bodyOfFirst}\n` : '') +
        '\nQuel mail correspond à CE colis, et que contient-il ?';
    try {
        const raw = (await complete(LLM_SYSTEM, user)).trim();
        const json = /\{[\s\S]*\}/.exec(raw)?.[0];
        if (!json) return null;
        const parsed = JSON.parse(json) as {
            choix?: number | null;
            articles?: string;
        };
        if (!parsed.choix || !parsed.articles) return null;
        const candidate = candidates[parsed.choix - 1];
        if (!candidate) return null;
        return { candidate, items: parsed.articles.slice(0, 120) };
    } catch (e) {
        Logger.warn(`deliveries content: LLM pick — ${e}`);
        return null;
    }
}

/**
 * Cherche le contenu d'un colis dans les mails de son marchand.
 * `claimed` = IDs de mails déjà appariés à d'autres colis.
 */
export async function findParcelContent(
    parcel: Parcel,
    claimed: Set<string>,
    deviceHandler: DeviceHandler,
    complete?: Complete,
): Promise<ContentMatch | null> {
    const merchant = parcel.label;
    // Un label qui n'est que le nom du transporteur ne désigne pas un
    // marchand — rien à chercher. (Amazon est marchand ET transporteur :
    // il reste cherchable.)
    if (!merchant || isPureCarrierName(merchant)) return null;

    const from = merchant.toLowerCase().split(/[\s.]/)[0];
    if (!from || from.length < 3) return null;
    const result = await deviceHandler('search_emails', {
        query: `from:${from} newer_than:10d`,
        maxResults: 12,
    });
    if (typeof result !== 'string' || result.startsWith('Aucun email')) {
        return null;
    }

    const parcelAge = Math.round((Date.now() - parcel.createdAt) / 86_400_000);
    const deliveredAge =
        parcel.status === 'delivered'
            ? Math.round((Date.now() - parcel.updatedAt) / 86_400_000)
            : null;
    let candidates = parseCandidates(result, claimed).filter((c) =>
        inDateWindow(c, parcelAge),
    );
    candidates = resolveByDeliveryDate(candidates, deliveredAge);
    if (!candidates.length) return null;

    // Si la règle des dates a tranché sur un « Livré » du même jour, c'est
    // le match le plus fort après le join exact.
    if (
        candidates.length === 1 &&
        candidates[0].items &&
        deliveredAge !== null &&
        /^livr/i.test(candidates[0].subject)
    ) {
        return {
            content: candidates[0].items,
            confidence: 'probable',
            mailId: candidates[0].id,
        };
    }

    // 1. Join exact : le numéro de suivi dans un corps de mail.
    const digits = parcel.tracking.replace(/\D/g, '');
    for (const c of candidates.slice(0, 3)) {
        const body = await deviceHandler('get_email', {
            messageId: c.id,
        }).catch(() => '');
        if (
            typeof body === 'string' &&
            digits.length >= 8 &&
            body.replace(/\D/g, '').includes(digits)
        ) {
            return {
                content: c.items ?? c.subject,
                confidence: 'sûr',
                mailId: c.id,
            };
        }
    }

    // 2. Un seul candidat avec articles → probable, sans LLM.
    const withItems = candidates.filter((c) => c.items);
    if (withItems.length === 1) {
        return {
            content: withItems[0].items!,
            confidence: 'probable',
            mailId: withItems[0].id,
        };
    }

    // 3. Plusieurs candidats (ou articles non extractibles) → LLM.
    if (complete) {
        let body: string | undefined;
        if (!withItems.length) {
            const raw = await deviceHandler('get_email', {
                messageId: candidates[0].id,
            }).catch(() => '');
            if (typeof raw === 'string') body = stripHtml(raw);
        }
        const picked = await llmPick(complete, parcel, candidates, body);
        if (picked) {
            return {
                content: picked.items,
                confidence: 'probable',
                mailId: picked.candidate.id,
            };
        }
    }

    // 4. Repli : le candidat à articles le plus proche de la date du colis.
    if (withItems.length) {
        const best = withItems.sort(
            (a, b) =>
                Math.abs(a.ageDays - parcelAge) -
                Math.abs(b.ageDays - parcelAge),
        )[0];
        return {
            content: best.items!,
            confidence: 'probable',
            mailId: best.id,
        };
    }
    return null;
}

/**
 * Enrichit les colis sans contenu (borné à `max` par tick pour limiter le
 * coût Gmail/LLM). Appelé par le watcher. Best-effort.
 */
export async function enrichParcelContents(
    deviceHandler: DeviceHandler,
    complete?: Complete,
    max = 2,
): Promise<void> {
    const parcels = listParcels();
    const claimed = new Set(
        parcels.map((p) => p.contentMailId).filter(Boolean) as string[],
    );
    let done = 0;
    for (const parcel of parcels) {
        if (done >= max) break;
        if (parcel.content || parcel.contentAttempts! >= 3) continue;
        done++;
        try {
            const match = await findParcelContent(
                parcel,
                claimed,
                deviceHandler,
                complete,
            );
            setContent(parcel.id, match);
            if (match) {
                claimed.add(match.mailId);
                Logger.info(
                    `deliveries: colis ${parcel.tracking} ↔ « ${match.content} » (${match.confidence})`,
                );
            }
        } catch (e) {
            Logger.warn(`deliveries content: ${parcel.tracking} — ${e}`);
        }
    }
}
