// Couche texte pure du brief : prompt LLM, garde-fou anti-invention et repli
// gabarité sans LLM. Aucune I/O ici — le composeur (Task 4) branche le LLM et
// l'émission ; ce module ne fait que produire/valider du texte.
import type { BriefFact } from './facts';

export const BRIEF_MAX_CHARS = 400;

export const BRIEF_SYSTEM_PROMPT =
    "Tu es la secrétaire de Jérémy. Voici les faits du moment, dans l'ordre d'importance. " +
    'Compose un point ORAL de 1 à 4 phrases, en français, en tutoyant, sans markdown ni emoji. ' +
    "N'invente rien : chaque phrase s'appuie sur un fait listé ; n'ajoute ni chiffre, ni nom, ni lieu absent des faits ; " +
    "ne rappelle pas ce qui n'est pas dans la liste. Va à l'essentiel, ton naturel de secrétaire. Réponds avec le texte seul.";

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

// Nombres (le `:` compte pour qu'une heure comme « 10:20 » reste un seul
// jeton) et mots capitalisés hors début de phrase (un début de phrase capitalisé
// n'a pas besoin d'être un fait — c'est de la grammaire, pas une invention).
const NUMBER_RE = /\d+(?:[.,:]\d+)?/g;
const CAPITALIZED_RE = /(?<![.!?]\s|^|["'«“‘])\b[A-ZÉÈÀÂÎÔÛÇ][\wéèàâîôûç'-]+/g;

function extractTokens(text: string): string[] {
    const numbers = text.match(NUMBER_RE) ?? [];
    const caps = text.match(CAPITALIZED_RE) ?? [];
    return [...numbers, ...caps];
}

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Lexique des jetons (chiffres, noms propres) tolérés dans un brief composé :
 *  ceux des faits + d'éventuelles chaînes supplémentaires (ex. le texte du
 *  détecteur de moment), plus jours/mois français et quelques mots fixes. */
export function allowedTokens(
    facts: BriefFact[],
    extra: string[] = [],
): Set<string> {
    const tokens = new Set<string>();
    for (const fact of facts) {
        for (const t of extractTokens(fact.text)) tokens.add(t);
    }
    for (const e of extra) {
        for (const t of extractTokens(e)) tokens.add(t);
    }
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
 *  sans ponctuation dans les bornes, coupe sec et marque la coupe par « … ». */
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
    return cut >= 0 ? slice.slice(0, cut + 1) : `${slice}…`;
}

/** Vérifie une sortie LLM contre les faits : longueur, chiffres et noms propres inconnus. Pur. */
export function checkComposed(
    text: string,
    facts: BriefFact[],
    extraAllowed: string[] = [],
): { ok: true; text: string } | { ok: false; reason: string } {
    const truncated = truncateToLimit(text.trim());
    const lexicon = allowedTokens(facts, extraAllowed);
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

/** Repli sans LLM : une phrase par fait, formulation fixe par nature. Pur. */
export function templateBrief(momentKind: string, facts: BriefFact[]): string {
    const prefix = MOMENT_PREFIX[momentKind] ?? 'Le point :';
    const out =
        facts.length === 0
            ? prefix.endsWith('.')
                ? prefix
                : `${prefix}.`
            : `${prefix} ${facts.map((f) => f.text).join(' ; ')}.`;
    return truncateToLimit(out);
}
