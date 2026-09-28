// Détecteur de signaux de masse : en-têtes, local part automatisées.
// Les signaux ne décident jamais seuls — une règle non confirmée peut être
// bloquée par une règle utilisateur opposée.
import type { MailRule, RuleMail } from './rules';
import { ruleFor, senderLocalPart, firstMatch, matchRule } from './rules';

export type Signal =
    | 'list-unsubscribe'
    | 'list-id'
    | 'precedence-bulk'
    | 'auto-submitted'
    | 'automated-sender';

export interface SignalHit {
    signal: Signal;
    category: 'newsletter' | 'notification';
}

// Parties locales d'adresses d'expéditeurs automatisés.
export const AUTOMATED_LOCAL_PARTS: ReadonlySet<string> = new Set([
    'no-reply',
    'noreply',
    'donotreply',
    'do-not-reply',
    'notification',
    'notifications',
    'mailer-daemon',
    'alert',
    'alerts',
]);

/**
 * Détecte un signal de masse dans un mail.
 *
 * Ordre de vérification (premier gagne) :
 * 1. List-Unsubscribe → newsletter
 * 2. List-Id → newsletter
 * 3. Precedence (bulk|list) → notification
 * 4. Auto-Submitted (auto-generated|auto-replied) → notification
 * 5. Partie locale automatisée → notification
 *
 * Retourne null si aucun signal.
 */
export function detectSignal(mail: RuleMail): SignalHit | null {
    // 1. List-Unsubscribe (case-insensitive header key and value)
    const listUnsubscribe = findHeaderCaseInsensitive(
        mail.headers,
        'List-Unsubscribe',
    );
    if (listUnsubscribe !== undefined) {
        return { signal: 'list-unsubscribe', category: 'newsletter' };
    }

    // 2. List-Id (case-insensitive header key and value)
    const listId = findHeaderCaseInsensitive(mail.headers, 'List-Id');
    if (listId !== undefined) {
        return { signal: 'list-id', category: 'newsletter' };
    }

    // 3. Precedence: bulk|list (case-insensitive)
    const precedence = findHeaderCaseInsensitive(mail.headers, 'Precedence');
    if (precedence) {
        const val = precedence.toLowerCase();
        if (val === 'bulk' || val === 'list') {
            return { signal: 'precedence-bulk', category: 'notification' };
        }
    }

    // 4. Auto-Submitted: auto-generated|auto-replied (case-insensitive)
    const autoSubmitted = findHeaderCaseInsensitive(
        mail.headers,
        'Auto-Submitted',
    );
    if (autoSubmitted) {
        const val = autoSubmitted.toLowerCase();
        if (val === 'auto-generated' || val === 'auto-replied') {
            return { signal: 'auto-submitted', category: 'notification' };
        }
    }

    // 5. Partie locale automatisée
    const local = senderLocalPart(mail.from).toLowerCase();
    if (AUTOMATED_LOCAL_PARTS.has(local)) {
        return { signal: 'automated-sender', category: 'notification' };
    }

    return null;
}

/**
 * Vérifie si un signal est autorisé (pas de règle utilisateur contraire).
 *
 * Retourne false (signal bloqué) si :
 * - Existe une règle confirmée pour cette adresse exacte (quelle que soit la catégorie)
 * - Existe une règle confirmée avec catégorie 'perso' qui matche le mail
 * - Existe une règle négative confirmée (then.category === null) qui matche
 *
 * Retourne true (signal autorisé) sinon.
 */
export function signalAllowed(rules: MailRule[], mail: RuleMail): boolean {
    // Vérifier s'il existe une règle confirmée pour cette adresse exacte
    const exactRule = ruleFor(rules, mail.from);
    if (exactRule && exactRule.confirmed) {
        return false;
    }

    // Chercher une règle confirmée qui matche
    const matchedRule = firstMatch(rules, mail);
    if (matchedRule && matchedRule.confirmed) {
        // Si c'est une règle perso ou une règle négative, bloquer le signal
        if (
            matchedRule.then.category === 'perso' ||
            matchedRule.then.category === null
        ) {
            return false;
        }
    }

    return true;
}

/**
 * Cherche un en-tête par clé insensible à la casse.
 * Retourne la valeur (non modifiée) ou undefined.
 */
function findHeaderCaseInsensitive(
    headers: Record<string, string>,
    key: string,
): string | undefined {
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lowerKey) {
            return v;
        }
    }
    return undefined;
}
