import Logger from '../logger';
import type { CollectedTool } from './types';

/**
 * Keyword → MCP server mapping for tool filtering.
 * If ANY keyword in an order matches, that server's tools are included.
 */
export const SERVER_KEYWORDS: Record<string, string[]> = {
    'mcp-hue': [
        'lumière',
        'lampe',
        'allume',
        'éteins',
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
    ],
    'mcp-nuki': ['porte', 'verrou', 'clé', 'ferme', 'ouvre', 'lock', 'door'],
    'mcp-spotify': [
        'musique',
        'spotify',
        'joue',
        'chanson',
        'playlist',
        'album',
        'artiste',
        'écoute',
        'volume',
        'pause',
        'music',
        'son',
        'radio',
        'morceau',
        'track',
        'shuffle',
        'repeat',
    ],
    'mcp-linear': [
        'linear',
        'ticket',
        'issue',
        'tâche',
        'projet',
        'koya',
        'bug',
    ],
    'mcp-samsung': [
        'tv',
        'télé',
        'télévision',
        'samsung',
        'écran',
        'hdmi',
        'volume',
    ],
    'mcp-chromecast': [
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
    ],
    'mcp-calendar': [
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
    ],
    'mcp-weather': [
        'météo',
        'temps',
        'température',
        'pluie',
        'soleil',
        'vent',
        'chaud',
        'froid',
        'nuage',
        'weather',
        'demain',
        'prévision',
        'semaine prochaine',
        'après-demain',
        'forecast',
    ],
    'mcp-obsidian': [
        'note',
        'obsidian',
        'fichier',
        'document',
        'écris',
        'journal',
        'vault',
    ],
    'mcp-gmail': [
        'email',
        'mail',
        'gmail',
        'message',
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
    ],
};

/**
 * Returns only the MCP tools relevant to the user's order, based on keyword
 * matching. Falls back to all tools if nothing matches so the LLM always has
 * a way to respond.
 *
 * This is the biggest latency lever: reducing from 67 → ~10 tools cuts input
 * tokens by ~60-70%, which directly lowers TTFT on every LLM call.
 */
export function filterToolsForOrder(
    order: string,
    collectedTools: CollectedTool[],
): CollectedTool[] {
    const lc = order.toLowerCase();
    const relevantServers = new Set<string>();
    for (const [server, keywords] of Object.entries(SERVER_KEYWORDS)) {
        if (keywords.some((kw) => lc.includes(kw))) {
            relevantServers.add(server);
        }
    }

    if (relevantServers.size === 0) {
        Logger.debug(
            `Tool filter: no match — sending all ${collectedTools.length} tools`,
        );
        return collectedTools;
    }

    const filtered = collectedTools.filter((ct) =>
        relevantServers.has(ct.serverName),
    );
    Logger.debug(
        `Tool filter: [${[...relevantServers].join(', ')}] → ${
            filtered.length
        }/${collectedTools.length} tools`,
    );
    return filtered;
}
