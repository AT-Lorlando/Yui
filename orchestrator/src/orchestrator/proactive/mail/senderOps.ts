// Ajout d'un expéditeur aux listes (routes POST /mail/senders/keep|spam) :
// remplace un éventuel doublon de `match` (un expéditeur change de liste
// plutôt que d'exister dans les deux) et retire l'inconnu correspondant de
// la file « à trier » du courrier.
import type { MailCourier } from './courier';
import {
    newKeepSender,
    newSpamSender,
    senderAddress,
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
    for (const u of courier.unknown()) {
        if (u.address.toLowerCase().endsWith(m)) {
            courier.forgetUnknown(u.address);
        }
    }
}

function dropSameMatch(senders: SenderStore, match: string): void {
    const m = match.toLowerCase();
    for (const s of [...senders.keep(), ...senders.spam()]) {
        if (s.match.toLowerCase() === m) senders.remove(s.id);
    }
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
    const s = newKeepSender(input, now);
    dropSameMatch(senders, s.match);
    senders.upsertKeep(s);
    forgetMatchedUnknowns(courier, s.match);
    return s;
}

export function addSpamSender(
    senders: SenderStore,
    courier: Courier,
    match: string,
    now: number,
): SpamSender {
    const s = newSpamSender(match, now);
    dropSameMatch(senders, s.match);
    senders.upsertSpam(s);
    forgetMatchedUnknowns(courier, s.match);
    return s;
}
