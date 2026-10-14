// Métadonnées Gmail (list_messages_meta) → mails du facteur. Repris tel quel
// du tri v2 (parseMetaList), seul le type est renommé.

export interface CourierMail {
    id: string;
    threadId: string;
    from: string;
    subject: string;
    snippet: string;
    headers: Record<string, string>;
    labelIds: string[];
    date: string;
}

/**
 * Sortie de list_messages_meta → mails. Le moteur livre déjà le tableau parsé
 * quand le texte est du JSON ; un texte brut est aussi accepté. Tout ce qui
 * n'est pas exploitable vaut [] (un mail sans id est ignoré).
 */
export function parseMetaList(raw: unknown): CourierMail[] {
    let list: unknown = raw;
    if (typeof raw === 'string') {
        try {
            list = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(list)) return [];
    const out: CourierMail[] = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : '';
        if (!id) continue;
        const headers: Record<string, string> = {};
        if (o.headers && typeof o.headers === 'object') {
            for (const [k, v] of Object.entries(
                o.headers as Record<string, unknown>,
            )) {
                if (typeof v === 'string') headers[k] = v;
            }
        }
        out.push({
            id,
            threadId: typeof o.threadId === 'string' ? o.threadId : '',
            from: typeof o.from === 'string' ? o.from : '',
            subject: typeof o.subject === 'string' ? o.subject : '',
            snippet: typeof o.snippet === 'string' ? o.snippet : '',
            headers,
            labelIds: Array.isArray(o.labelIds)
                ? o.labelIds.filter((l): l is string => typeof l === 'string')
                : [],
            date: typeof o.date === 'string' ? o.date : '',
        });
    }
    return out;
}
