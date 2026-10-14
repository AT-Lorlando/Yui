// Ajout d'un expéditeur aux listes (routes POST /mail/senders/keep|spam) :
// remplace un éventuel doublon de `match` (un expéditeur change de liste
// plutôt que d'exister dans les deux) et retire l'inconnu correspondant de
// la file « à trier » du courrier.
import type { MailCourier } from './courier';
import {
    assertSafeMatch,
    newKeepSender,
    newSpamSender,
    senderAddress,
    validateKeepFields,
    type ContentRule,
    type KeepSender,
    type ReadMode,
    type SenderStore,
    type SpamSender,
} from './senders';

type Courier = Pick<MailCourier, 'unknown' | 'forgetUnknown'>;

/** Adresse : oublie cet inconnu ; domaine (`@x.fr`, `x.fr`) : tous ceux qui s'y terminent. */
export function forgetMatchedUnknowns(courier: Courier, match: string): void {
    const m = match.trim().toLowerCase();
    if (m.includes('@') && !m.startsWith('@')) {
        courier.forgetUnknown(senderAddress(m));
        return;
    }
    // domaine : frontière « @ » (x.fr ne couvre pas a@notx.fr) ou sous-domaine
    const domain = m.replace(/^@/, '');
    for (const u of courier.unknown()) {
        const a = u.address.toLowerCase();
        if (
            a === domain ||
            a.endsWith('@' + domain) ||
            a.endsWith('.' + domain)
        ) {
            courier.forgetUnknown(u.address);
        }
    }
}

/** Ids des entrées de même `match` (casse ignorée), à retirer APRÈS l'ajout du nouveau. */
function sameMatchIds(senders: SenderStore, match: string, except: string) {
    const m = match.toLowerCase();
    return [...senders.keep(), ...senders.spam()]
        .filter((s) => s.match.toLowerCase() === m && s.id !== except)
        .map((s) => s.id);
}

export function addKeepSender(
    senders: SenderStore,
    courier: Courier,
    input: {
        match: string;
        name: string;
        read?: ReadMode;
        rules?: ContentRule[];
        readDefault?: boolean;
    },
    now: number,
): KeepSender {
    // valider AVANT toute écriture : rien n'est touché si l'entrée est invalide
    validateKeepFields(
        { ...input, read: input.read ?? 'never' } as Record<string, unknown>,
        'expéditeur',
    );
    const s = newKeepSender(input, now);
    senders.upsertKeep(s);
    for (const id of sameMatchIds(senders, s.match, s.id)) senders.remove(id);
    forgetMatchedUnknowns(courier, s.match);
    return s;
}

export function addSpamSender(
    senders: SenderStore,
    courier: Courier,
    match: string,
    now: number,
): SpamSender {
    assertSafeMatch(match, 'expéditeur'); // avant toute écriture
    const s = newSpamSender(match, now);
    senders.upsertSpam(s);
    for (const id of sameMatchIds(senders, s.match, s.id)) senders.remove(id);
    forgetMatchedUnknowns(courier, s.match);
    return s;
}
