// Corps de `POST /notify` (notification poussée par un autre dépôt — Koya,
// Genkin, Astronix, Aster…). Validation pure, testée.

export interface NotifyRequest {
    /** Texte de la notification (et du TTS si `speak`). */
    text: string;
    /** Titre affiché sur le téléphone. Défaut : le nom de la source, sinon « Yui ». */
    title: string;
    /** Nom de l'app émettrice, pour le journal d'activité. */
    source?: string;
    /** Lire aussi à voix haute sur l'enceinte (si le pipeline voix tourne). */
    speak: boolean;
}

export const NOTIFY_TEXT_MAX = 500;
export const NOTIFY_TITLE_MAX = 80;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Lève une erreur lisible (→ 400) si le corps est invalide. */
export function parseNotifyRequest(body: unknown): NotifyRequest {
    const b = (body && typeof body === 'object' ? body : {}) as Record<
        string,
        unknown
    >;
    // `message` et `body` acceptés en alias : les webhooks des autres apps
    // n'ont pas tous le même vocabulaire.
    const text = str(b.text) || str(b.message) || str(b.body);
    if (!text) throw new Error('text requis');
    if (text.length > NOTIFY_TEXT_MAX) {
        throw new Error(`text trop long (max ${NOTIFY_TEXT_MAX} caractères)`);
    }
    const source = str(b.source).slice(0, 40) || undefined;
    const title = (str(b.title) || source || 'Yui').slice(0, NOTIFY_TITLE_MAX);
    const speak = b.speak === true || b.speak === 'true';
    return { text, title, speak, ...(source ? { source } : {}) };
}
