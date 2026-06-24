import Logger from '../logger';
import type { CollectedTool } from './types';

export interface ServerGroup {
    name: string;
    servers: string[];
    keywords: string[];
    /** Filename inside prompts/domains/ to inject when this group is active. */
    promptFile: string;
}

export const SERVER_GROUPS: ServerGroup[] = [
    {
        name: 'domotique',
        servers: [
            'mcp-hue',
            'mcp-nuki',
            'mcp-somfy',
            'mcp-spotify',
            'mcp-chromecast',
            'mcp-smartthings',
            'mcp-timer',
        ],
        keywords: [
            // lights
            'lumière',
            'lampe',
            'allume',
            'allumer',
            'allumé',
            'éteins',
            'éteindre',
            'éteint',
            'éclairage',
            'luminosité',
            'couleur',
            'light',
            'lamp',
            'chambre',
            'salon',
            'cuisine',
            'bureau',
            'salle',
            'ambiance',
            'bright',
            'dim',
            'appartement',
            // doors
            'porte',
            'verrou',
            'clé',
            'ferme',
            'fermer',
            'ouvre',
            'ouvrir',
            'verrouille',
            'verrouiller',
            'déverrouille',
            'déverrouiller',
            'lock',
            'door',
            // shutters / somfy
            'volet',
            'store',
            'pergola',
            'portail',
            'rideau',
            'somfy',
            'tahoma',
            'fenêtre',
            'monte',
            'descend',
            'shutter',
            'blind',
            // music
            'musique',
            'spotify',
            'joue',
            'jouer',
            'chanson',
            'playlist',
            'album',
            'artiste',
            'écoute',
            'écouter',
            'volume',
            'pause',
            'music',
            'son',
            'radio',
            'morceau',
            'track',
            'shuffle',
            'repeat',
            'mets',
            'mettre',
            'mettre',
            // timers
            'minuteur',
            'timer',
            'chrono',
            'compte à rebours',
            'sonne',
            'sonner',
            'dans',
            'minutes',
            'heures',
            'secondes',
            // scenes
            'scène',
            'scene',
            'mode',
            'ambiance',
            // TV / video / casting
            'tv',
            'télé',
            'télévision',
            'samsung',
            'écran',
            'hdmi',
            'chromecast',
            'cast',
            'netflix',
            'crunchyroll',
            'youtube',
            'disney',
            'prime',
            'amazon',
            'cinéma',
            'film',
            'série',
            'diffuse',
            'stream',
            'vidéo',
            'anime',
            'animé',
            'épisode',
            // verbes génériques de lancement (sans contexte ils tombent ici)
            'lance',
            'lancer',
            'lancement',
            'regarde',
            'regarder',
            'voir',
            'mate',
            'mater',
            'visionne',
            'ouvre',
            'ouvrir',
            'démarre',
            'démarrer',
        ],
        promptFile: 'domotique.md',
    },
    {
        name: 'prevoyance',
        servers: ['mcp-calendar', 'mcp-weather'],
        keywords: [
            // calendar
            'calendrier',
            'agenda',
            'réunion',
            'rendez-vous',
            'événement',
            'planning',
            'semaine',
            'demain',
            'lundi',
            'mardi',
            'mercredi',
            'jeudi',
            'vendredi',
            'samedi',
            'dimanche',
            'aujourd',
            'mois',
            'après-demain',
            // weather
            'météo',
            'température',
            'pluie',
            'soleil',
            'vent',
            'chaud',
            'froid',
            'nuage',
            'weather',
            'prévision',
            'forecast',
            // scheduling
            'rappelle',
            'planifie',
            'schedule',
            'programme',
        ],
        promptFile: 'prevoyance.md',
    },
    {
        name: 'secretariat',
        servers: ['mcp-gmail', 'mcp-linear', 'mcp-yoji'],
        keywords: [
            // email
            'email',
            'mail',
            'gmail',
            'inbox',
            'boîte',
            'envoie',
            'reçu',
            'expéditeur',
            'destinataire',
            'objet',
            'pièce jointe',
            'brouillon',
            'archive',
            'corbeille',
            'non lu',
            'marque',
            // linear / dev
            'linear',
            'ticket',
            'issue',
            'tâche',
            'projet',
            'koya',
            'bug',
            // yoji todos
            'todo',
            'todolist',
        ],
        promptFile: 'secretariat.md',
    },
    {
        name: 'connaissance',
        servers: ['mcp-yoji', 'mcp-browser'],
        keywords: [
            'note',
            'yoji',
            'fichier',
            'document',
            'écris',
            'journal',
            'vault',
            'navigue',
            'browser',
        ],
        promptFile: 'connaissance.md',
    },
    {
        name: 'domotique-jardin',
        servers: ['mcp-irrigation'],
        keywords: [
            'arrose',
            'arroser',
            'arrosage',
            'irrigation',
            'plantes',
            'jardin',
            'pompe',
            'eau',
            'goutte',
            'minuteur arrosage',
        ],
        promptFile: 'domotique.md',
    },
    {
        name: 'recherche',
        servers: ['mcp-search'],
        keywords: [
            'cherche',
            'recherche',
            'google',
            'internet',
            'web',
            'actualité',
            'actualités',
            'info',
            'infos',
            'nouvelles',
            'news',
            'article',
            'source',
            'score',
            'résultat',
            'classement',
            'prix',
            'disponible',
            'sorti',
            'sortie',
            'annoncé',
            'annonce',
            'récent',
            'dernier',
            'dernière',
            'derniers',
            'nouvelles',
            'en ce moment',
            "aujourd'hui",
            'cette semaine',
            'mise à jour',
        ],
        promptFile: 'connaissance.md',
    },
];

/**
 * Resolves which domain groups match the user's order via keyword scanning.
 * Returns an empty array when nothing matches (caller falls back to all tools
 * and core-only prompt).
 */
function normalize(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

export function resolveGroups(order: string): ServerGroup[] {
    const norm = normalize(order);
    return SERVER_GROUPS.filter((g) =>
        g.keywords.some((kw) => norm.includes(normalize(kw))),
    );
}

/**
 * Returns MCP tools relevant to the matched groups.
 * Falls back to the full tool list if no group matched so the LLM is never
 * left tool-less on ambiguous or general requests.
 */
export function filterToolsForOrder(
    order: string,
    collectedTools: CollectedTool[],
    groups?: ServerGroup[],
): CollectedTool[] {
    const matched = groups ?? resolveGroups(order);

    if (matched.length === 0) {
        Logger.debug(
            `Tool filter: no group match — virtual tools only (no MCP tools)`,
        );
        return [];
    }

    const relevantServers = new Set(matched.flatMap((g) => g.servers));
    const filtered = collectedTools.filter((ct) =>
        relevantServers.has(ct.serverName),
    );

    Logger.debug(
        `Tool filter: [${matched.map((g) => g.name).join(', ')}] → ` +
            `${filtered.length}/${collectedTools.length} tools`,
    );
    return filtered;
}
