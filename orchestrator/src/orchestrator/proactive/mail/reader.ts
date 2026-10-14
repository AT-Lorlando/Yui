import * as fs from 'fs';
import * as path from 'path';
import { MailOrder, ordersPrompt } from './orders';

export interface ReaderMail {
    id: string;
    from: string;
    subject: string;
    date?: string;
    body: string;
    /** Nom de la boîte si l'expéditeur est gardé. */
    box?: string;
}

export interface ReaderItem {
    notify: boolean;
    urgency: 'none' | 'soon' | 'now';
    reason: string;
    orderId?: string;
    fulfilled?: boolean;
    facts: string[];
}

export const DEFAULT_READER_PROMPT = `Tu es la secrétaire de Jérémy et tu lis sa boîte mail. Pour chaque mail, tu décides d'une seule chose : faut-il le prévenir ?

Ça mérite de le prévenir :
- une réponse qu'il attendait ;
- une échéance dans les 7 jours (document à fournir, paiement, rendez-vous) ;
- de l'argent qui bouge (paiement, remboursement, prélèvement inhabituel) ;
- un vrai événement de sécurité qui demande un geste de sa part ;
- une livraison (colis en route, à retirer, retardé).

Ça ne mérite JAMAIS de le prévenir : promotion, newsletter, notification automatique, rapport périodique, message marketing, même s'il dit « urgent » ou « dernière chance ».

Urgence : "now" = à traiter aujourd'hui ; "soon" = dans les jours qui viennent ; "none" sinon.
"reason" : une ligne factuelle. "facts" : chiffres, dates et noms copiés tels quels du mail, jamais inventés.
Si le mail répond à l'un des ordres en cours, renseigne "orderId" ; ajoute "fulfilled": true seulement quand il règle vraiment l'ordre.`;

/** prompts/mail-reader.md si présent et non vide, sinon le prompt par défaut. */
export function loadReaderPrompt(
    dir = path.resolve(process.cwd(), 'prompts'),
): string {
    try {
        const txt = fs.readFileSync(path.join(dir, 'mail-reader.md'), 'utf-8');
        if (txt.trim()) return txt.trim();
    } catch {
        /* absent → défaut */
    }
    return DEFAULT_READER_PROMPT;
}

export function buildReaderSystem(
    general: string,
    orders: MailOrder[],
): string {
    const list = ordersPrompt(orders);
    const section = list ? `\n\nOrdres en cours :\n${list}` : '';
    return `${general}${section}

Réponds UNIQUEMENT en JSON, sans texte autour : [{"i":1,"notify":true,"urgency":"now","reason":"…","orderId":"o-3","fulfilled":true,"facts":["…"]}] — un objet par mail, dans l'ordre. "orderId", "fulfilled" et "facts" sont facultatifs.`;
}

export function buildReaderUser(mails: ReaderMail[]): string {
    return mails
        .map((m, i) => {
            const head = [`De: ${m.from}`, `Objet: ${m.subject}`];
            if (m.date) head.push(`Date: ${m.date}`);
            if (m.box) head.push(`Boîte: ${m.box}`);
            return `${i + 1}. ${head.join(' | ')}\n   Corps: ${m.body}`;
        })
        .join('\n\n');
}

/** Parse la réponse du lecteur — null par mail illisible. Pur, testé. */
export function parseReaderReply(
    raw: string,
    count: number,
    orderIds: Set<string>,
): Array<ReaderItem | null> {
    const out: Array<ReaderItem | null> = new Array(count).fill(null);
    const m = /\[[\s\S]*\]/.exec(raw);
    if (!m) return out;
    try {
        const arr = JSON.parse(m[0]);
        if (!Array.isArray(arr)) return out;
        for (const item of arr) {
            const i = Number(item?.i) - 1;
            if (!Number.isInteger(i) || i < 0 || i >= count) continue;
            const facts: string[] = [];
            for (const f of Array.isArray(item?.facts) ? item.facts : []) {
                if (typeof f !== 'string') continue;
                const t = f.trim().slice(0, 120);
                if (t) facts.push(t);
                if (facts.length >= 5) break;
            }
            const entry: ReaderItem = {
                notify: item?.notify === true,
                urgency:
                    item?.urgency === 'soon' || item?.urgency === 'now'
                        ? item.urgency
                        : 'none',
                reason:
                    typeof item?.reason === 'string'
                        ? item.reason.trim().slice(0, 160)
                        : '',
                facts,
            };
            if (
                typeof item?.orderId === 'string' &&
                orderIds.has(item.orderId)
            ) {
                entry.orderId = item.orderId;
                if (item.fulfilled === true) entry.fulfilled = true;
            }
            out[i] = entry;
        }
    } catch {
        /* réponse illisible → tous null */
    }
    return out;
}
