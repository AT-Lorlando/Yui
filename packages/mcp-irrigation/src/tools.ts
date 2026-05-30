import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, AMOUNT_KEYS } from './config';

/**
 * Builds the tool definitions from the current config so the LLM only sees
 * the actual pump names + currently configured amount keys. Called each time
 * ListTools is invoked, so a config change is picked up at the next request.
 */
export function buildIrrigationTools(): Tool[] {
    const cfg = loadConfig();
    const pumpNames = (['A', 'B'] as const).map((p) => cfg.pumps[p].name);
    const targetOptions = pumpNames.map((n) => `"${n}"`).join(', ');
    const amountDescr = AMOUNT_KEYS.map(
        (k) => `"${k}" (${cfg.amounts[k]}s)`,
    ).join(', ');

    return [
        {
            name: 'irrigation_status',
            description:
                "État actuel des pompes d'irrigation : pour chaque pompe, son nom, active ou non, " +
                'et secondes restantes si un compte à rebours est en cours.',
            inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
            name: 'irrigation_start',
            description:
                "Démarrer l'arrosage d'une zone. La durée est déterminée par le niveau choisi (jamais libre). " +
                `Niveaux actuels : ${amountDescr}. ` +
                'Heuristique : "arrose un peu" → "petit", "arrose" sans précision → "normal", "arrose bien/beaucoup" → "grand". ' +
                "L'arrêt automatique est géré côté serveur, ne rappelle pas stop.",
            inputSchema: {
                type: 'object',
                properties: {
                    target: {
                        type: 'string',
                        description: `Zone à arroser : ${targetOptions} pour une pompe spécifique, ou "all" pour les deux. Insensible à la casse / aux accents. Si Jérémy n'a pas précisé, mets "all".`,
                    },
                    amount: {
                        type: 'string',
                        enum: AMOUNT_KEYS,
                        description:
                            'Niveau de quantité (durées définies dans la config).',
                    },
                },
                required: ['target', 'amount'],
            },
        },
        {
            name: 'irrigation_stop',
            description:
                "Arrêter immédiatement l'arrosage. Annule aussi tout compte à rebours en cours.",
            inputSchema: {
                type: 'object',
                properties: {
                    target: {
                        type: 'string',
                        description: `Zone à arrêter : ${targetOptions} ou "all" (défaut).`,
                    },
                },
                required: [],
            },
        },
        {
            name: 'irrigation_discover_dps',
            description:
                'Debug — dump des DPS Tuya bruts. Setup uniquement, ne pas appeler en production.',
            inputSchema: { type: 'object', properties: {}, required: [] },
        },
    ];
}
