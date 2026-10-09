// Nettoyage markdown d'une réponse LLM destinée au TTS, et son application
// EN STREAMING sans perdre de tokens.
//
// Bug du 09/10/2026 : le nettoyage était recalculé sur tout le tampon à chaque
// token et on émettait `clean.slice(déjàÉmis)`. Or il n'est pas monotone : « 1. »
// part au client, puis le token suivant complète le motif « 1. Lire », le
// nettoyage retire « 1. », le texte propre RACCOURCIT, et `slice` saute des
// caractères — l'app affichait « 2. mail … 3.re le seul message ».
//
// Règle : on ne nettoie que le PRÉFIXE STABLE du tampon (ce qui ne peut plus
// être transformé par l'arrivée des tokens suivants), et on n'émet que ce qui
// prolonge ce qui a déjà été envoyé.

/**
 * Strips markdown syntax and emojis from a TTS-bound response.
 * The LLM is instructed not to use markdown, but this is a safety net
 * in case it ignores the rule (e.g. after a model update).
 */
export function stripMarkdownForTts(text: string): string {
    return (
        text
            // Bold / italic: **text**, *text*, __text__, _text_
            .replace(/\*\*(.+?)\*\*/gs, '$1')
            .replace(/\*(.+?)\*/gs, '$1')
            .replace(/__(.+?)__/gs, '$1')
            .replace(/_(.+?)_/gs, '$1')
            // Headings: # ## ###
            .replace(/^#{1,6}\s+/gm, '')
            // Bullet lists: - item, * item (start of line)
            .replace(/^[\s]*[-*]\s+/gm, '')
            // Numbered lists: 1. 2. etc
            .replace(/^\s*\d+\.\s+/gm, '')
            // Backticks: `code` and ```blocks```
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`(.+?)`/g, '$1')
            // Hex color codes like #2E8B57 (not useful orally)
            .replace(/#[0-9A-Fa-f]{6}\b/g, '')
            // Emojis (broad unicode range)
            .replace(
                /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}]/gu,
                '',
            )
            // Collapse multiple blank lines to one
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    );
}

const count = (s: string, needle: string): number => s.split(needle).length - 1;

/** `*`, `_` ou backtick ouvert dans la ligne (« ** » compte comme une paire). */
function hasOpenInline(tail: string): boolean {
    const bold = count(tail, '**');
    const star = count(tail.replace(/\*\*/g, ''), '*');
    const dunder = count(tail, '__');
    const under = count(tail.replace(/__/g, ''), '_');
    return Boolean(
        bold % 2 || star % 2 || dunder % 2 || under % 2 || count(tail, '`') % 2,
    );
}

/**
 * Longueur du préfixe de `raw` dont le nettoyage ne changera plus quand la
 * suite arrivera : on retient la ligne en cours tant qu'elle peut encore
 * devenir un marqueur de liste/titre ou qu'un `*`, `_` ou backtick y est
 * ouvert, et on ne coupe jamais au milieu d'un mot (motif #RRGGBB).
 */
export function stablePrefixLength(raw: string): number {
    const lineStart = raw.lastIndexOf('\n') + 1;
    const tail = raw.slice(lineStart);
    if (/^\s*(\d+\.?|[-*#]{1,6})?\s*$/.test(tail)) return lineStart;
    const lastWs = Math.max(raw.lastIndexOf(' '), raw.lastIndexOf('\t'));
    const cut = Math.max(lineStart, lastWs + 1);
    // Le segment qu'on s'apprête à émettre ne doit pas laisser une emphase ou
    // un code ouvert : sa fermeture arrivera après la coupe et changerait le
    // nettoyage de ce qui serait déjà parti.
    if (hasOpenInline(raw.slice(lineStart, cut))) return lineStart;
    return cut;
}

/** Émet, token après token, la version nettoyée d'un tampon qui grandit. */
export class StreamCleaner {
    private sent = '';

    /** À appeler avec le tampon COMPLET courant ; rend ce qu'il faut émettre. */
    push(raw: string): string {
        return this.emit(
            stripMarkdownForTts(raw.slice(0, stablePrefixLength(raw))),
        );
    }

    /** Fin de tour : rend le reliquat (le nettoyage du tampon entier). */
    finish(raw: string): string {
        return this.emit(stripMarkdownForTts(raw));
    }

    get sentLength(): number {
        return this.sent.length;
    }

    private emit(clean: string): string {
        // Prolongement normal : on émet la suite. Si le préfixe stable a
        // reculé (un backtick ou une emphase s'ouvre sur une ligne déjà
        // partiellement émise), `clean` est plus court : on attend sans rien
        // reprendre — ce qui est parti au client ne se retire pas. Vraie
        // divergence (ne doit pas arriver) : on n'émet que ce qui dépasse.
        if (clean.startsWith(this.sent)) {
            const delta = clean.slice(this.sent.length);
            this.sent = clean;
            return delta;
        }
        if (clean.length <= this.sent.length) return '';
        const delta = clean.slice(this.sent.length);
        this.sent = clean;
        return delta;
    }
}
