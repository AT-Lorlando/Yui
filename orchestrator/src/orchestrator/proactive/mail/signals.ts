// Détecteur de signaux de masse : en-têtes, local part automatisées.
// Les signaux ne décident plus rien : ils pré-cochent « Osef » dans la file
// des nouveaux expéditeurs (courrier v3).
import { senderAddress } from './senders';

/** Ce que le détecteur lit d'un mail. */
export interface SignalInput {
    from: string;
    subject?: string;
    headers: Record<string, string>;
}

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
export function detectSignal(mail: SignalInput): SignalHit | null {
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
    const address = senderAddress(mail.from);
    const at = address.indexOf('@');
    const local = (at >= 0 ? address.slice(0, at) : address).toLowerCase();
    if (AUTOMATED_LOCAL_PARTS.has(local)) {
        return { signal: 'automated-sender', category: 'notification' };
    }

    return null;
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
