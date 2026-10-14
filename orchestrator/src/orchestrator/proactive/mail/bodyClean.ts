export const BODY_MAX = 2_500;
const MARKER = '--- Corps ---';
const QUOTE_START = [
    /^Le .{5,80} a écrit\s?:/m,
    /^On .{5,80} wrote:/m,
    /^-{3,}\s*Original Message\s*-{3,}/m,
    /^De\s?:.*\n(Envoyé|Date)\s?:/m,
    /^_{10,}$/m,
];
const FOOTER =
    /^.*(se désabonner|désinscri|unsubscribe|mentions légales|vous recevez ce (mail|message|courriel)|cet e-?mail (vous )?a été envoyé|ne pas répondre à ce message).*$/im;

/**
 * Pied de page : coupé à partir de la ligne trouvée seulement si elle est
 * dans la seconde moitié du corps — « merci de ne pas répondre à ce
 * message » en TÊTE d'un mail transactionnel effacerait tout. Plus haut, on
 * ne retire que cette ligne, puis on cherche la suivante.
 */
function cutFooter(body: string): string {
    for (;;) {
        const foot = FOOTER.exec(body);
        if (!foot) return body;
        if (foot.index >= body.length / 2) return body.slice(0, foot.index);
        const end = foot.index + foot[0].length;
        body = body.slice(0, foot.index) + body.slice(end + 1);
    }
}

export function cleanBody(full: string, max = BODY_MAX): string {
    const idx = full.indexOf(MARKER);
    let body = idx >= 0 ? full.slice(idx + MARKER.length) : full;
    for (const re of QUOTE_START) {
        const m = re.exec(body);
        if (m) body = body.slice(0, m.index);
    }
    const sig = /^-- ?$/m.exec(body);
    if (sig) body = body.slice(0, sig.index);
    body = cutFooter(body);
    body = body
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('>'))
        .join('\n')
        .replace(/https?:\/\/\S+/g, '[lien]')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
    return body.length > max ? body.slice(0, max) + '…' : body;
}
