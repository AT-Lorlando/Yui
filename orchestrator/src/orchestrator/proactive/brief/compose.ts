// Couche texte pure du brief : prompt LLM, garde-fou anti-invention et repli
// gabarité sans LLM. Aucune I/O ici — le composeur branche le LLM et
// l'émission ; ce module ne fait que produire/valider du texte.
import type { BriefFact } from './facts';

export const BRIEF_MAX_CHARS = 400;

export const BRIEF_SYSTEM_PROMPT =
    "Tu es la secrétaire de Jérémy. Voici les faits du moment, dans l'ordre d'importance. " +
    'Compose un point ORAL de 1 à 4 phrases, en français, en tutoyant, sans markdown ni emoji. ' +
    "N'invente rien : chaque phrase s'appuie sur un fait listé ; n'ajoute ni chiffre, ni nom, ni lieu absent des faits ; " +
    "ne rappelle pas ce qui n'est pas dans la liste. Un post-it « ouvert depuis N jours » est un rappel qui attend depuis N jours : " +
    "ce n'est jamais une échéance ni un compte à rebours. Va à l'essentiel, ton naturel de secrétaire. Réponds avec le texte seul.";

const FR_DAYS = [
    'lundi',
    'mardi',
    'mercredi',
    'jeudi',
    'vendredi',
    'samedi',
    'dimanche',
];
const FR_MONTHS = [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre',
];
// Toujours tolérés : identités récurrentes et mots-outils des préfixes de moment.
const FIXED_ALLOWED = [
    'Jérémy',
    'Yui',
    'Rien',
    'Bonjour',
    'Pendant',
    'Avant',
    'Le',
];

const MOMENT_PREFIX: Record<string, string> = {
    'moment-wake': 'Bonjour.',
    'moment-return': 'Pendant ton absence :',
    'moment-bedtime': 'Avant de dormir :',
    'moment-departure': 'Avant de partir :',
    'on-demand': 'Le point :',
};

// Phrase neutre quand aucun fait n'a de matière — pas de « : » suivi de rien.
const MOMENT_EMPTY: Record<string, string> = {
    'moment-wake': 'Bonjour.',
    'moment-return': 'Rien de particulier pendant ton absence.',
    'moment-bedtime': 'Rien à signaler avant de dormir.',
    'moment-departure': 'Rien à signaler avant de partir.',
    'on-demand': 'Rien de nouveau.',
};

// Nombres (le `:` compte pour qu'une heure comme « 10:20 » reste un seul
// jeton) et mots capitalisés hors début de phrase (un début de phrase capitalisé
// n'a pas besoin d'être un fait — c'est de la grammaire, pas une invention).
// Pas d'exemption pour les guillemets : un nom propre cité entre guillemets
// (« Bastien ») doit rester soumis au contrôle, sinon la garde serait
// contournable en citant n'importe quoi.
const NUMBER_RE = /\d+(?:[.,:]\d+)?/g;
const CAPITALIZED_RE = /(?<![.!?]\s|^)\b[A-ZÉÈÀÂÎÔÛÇ][\wéèàâîôûç'-]+/g;
// Même forme, sans l'exemption de début de phrase : un libellé (titre
// d'événement, lieu, participant) n'est pas une phrase, son premier mot est
// un fait comme les autres (« Bastien dîner »).
const LABEL_CAPITALIZED_RE = /\b[A-ZÉÈÀÂÎÔÛÇ][\wéèàâîôûç'-]+/g;

function extractTokens(text: string): string[] {
    const numbers = text.match(NUMBER_RE) ?? [];
    const caps = text.match(CAPITALIZED_RE) ?? [];
    return [...numbers, ...caps];
}

/** Jetons (chiffres, mots capitalisés) de libellés — pas de phrases — pour
 *  bâtir un lexique d'ancrage. Pur. */
export function lexiconTokens(labels: string[]): Set<string> {
    const tokens = new Set<string>();
    for (const label of labels) {
        for (const t of label.match(NUMBER_RE) ?? []) tokens.add(t);
        for (const t of label.match(LABEL_CAPITALIZED_RE) ?? []) tokens.add(t);
    }
    return tokens;
}

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Lexique des jetons (chiffres, noms propres) tolérés dans un brief composé :
 *  ceux des faits + d'éventuelles chaînes supplémentaires (ex. le texte du
 *  détecteur de moment), plus jours/mois français et quelques mots fixes.
 *  Bâti via `lexiconTokens` (pas `extractTokens`) : un fait est un libellé,
 *  pas une phrase — son premier mot (« Koya », « Bastien »…) est un jeton
 *  comme les autres, l'exemption de début de phrase ne s'applique qu'à la
 *  sortie du LLM vérifiée plus bas. */
export function allowedTokens(
    facts: BriefFact[],
    extra: string[] = [],
): Set<string> {
    const tokens = lexiconTokens([...facts.map((f) => f.text), ...extra]);
    for (const day of FR_DAYS) {
        tokens.add(day);
        tokens.add(capitalize(day));
    }
    for (const month of FR_MONTHS) {
        tokens.add(month);
        tokens.add(capitalize(month));
    }
    for (const word of FIXED_ALLOWED) tokens.add(word);
    return tokens;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function formatDateFr(ts: number): string {
    const d = new Date(ts);
    return `${pad2(d.getDate())}/${pad2(
        d.getMonth() + 1,
    )}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function buildBriefUser(input: {
    momentKind: string;
    momentFacts: string;
    now: number;
    presence: string;
    facts: BriefFact[];
}): string {
    const { momentKind, momentFacts, now, presence, facts } = input;
    const momentLine = momentFacts
        ? `Moment : ${momentKind} (${momentFacts})`
        : `Moment : ${momentKind}`;
    const lines = [
        momentLine,
        `Présence : ${presence}`,
        `Heure : ${formatDateFr(now)}`,
        'Faits :',
    ];
    facts.forEach((fact, i) => lines.push(`${i + 1}. ${fact.text}`));
    return lines.join('\n');
}

/** Tronque au dernier `.`/`!`/`?` avant `BRIEF_MAX_CHARS` (ponctuation gardée) ;
 *  sans ponctuation dans les bornes, coupe sec un caractère plus tôt et
 *  ajoute « … » pour rester dans la limite (399 + 1 caractère de coupe). */
function truncateToLimit(text: string): string {
    if (text.length <= BRIEF_MAX_CHARS) return text;
    const slice = text.slice(0, BRIEF_MAX_CHARS);
    let cut = -1;
    for (let i = slice.length - 1; i >= 0; i--) {
        if (slice[i] === '.' || slice[i] === '!' || slice[i] === '?') {
            cut = i;
            break;
        }
    }
    return cut >= 0
        ? slice.slice(0, cut + 1)
        : `${text.slice(0, BRIEF_MAX_CHARS - 1)}…`;
}

/** Vérifie une sortie LLM contre un lexique déjà bâti : longueur, chiffres et
 *  noms propres inconnus. Pur. */
export function checkAgainstLexicon(
    text: string,
    lexicon: Set<string>,
): { ok: true; text: string } | { ok: false; reason: string } {
    const truncated = truncateToLimit(text.trim());
    for (const token of extractTokens(truncated)) {
        if (!lexicon.has(token)) {
            return {
                ok: false,
                reason: `jeton absent des faits : « ${token} »`,
            };
        }
    }
    return { ok: true, text: truncated };
}

/** Vérifie une sortie LLM contre les faits : longueur, chiffres et noms propres inconnus. Pur. */
export function checkComposed(
    text: string,
    facts: BriefFact[],
    extraAllowed: string[] = [],
): { ok: true; text: string } | { ok: false; reason: string } {
    return checkAgainstLexicon(text, allowedTokens(facts, extraAllowed));
}

/** Repli sans LLM : une phrase par fait, formulation fixe par nature. Pur. */
export function templateBrief(momentKind: string, facts: BriefFact[]): string {
    if (facts.length === 0) {
        return MOMENT_EMPTY[momentKind] ?? 'Rien de nouveau.';
    }
    const prefix = MOMENT_PREFIX[momentKind] ?? 'Le point :';
    const out = `${prefix} ${facts.map((f) => f.text).join(' ; ')}.`;
    return truncateToLimit(out);
}
