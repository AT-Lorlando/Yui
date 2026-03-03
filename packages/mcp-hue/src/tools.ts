/**
 * Build the Hue MCP tool definitions.
 * Room and light names are injected at startup so the LLM never needs list_lights.
 *
 * Tool decision guide:
 *   turn_on/off_all_lights   — whole flat
 *   set_lights(target, ...)  — on/off/brightness for a room OR any state for one light
 *   set_room_palette(room, colors[]) — color atmosphere for a room (each light gets a different shade)
 */
export function buildHueTools(roomNames: string[], lightNames: string[] = []) {
    const roomList = roomNames.length > 0 ? roomNames.join(', ') : '(chargement…)';
    const lightList = lightNames.length > 0 ? lightNames.join(', ') : '(chargement…)';

    return [
        // ── Whole flat ────────────────────────────────────────────────────────
        {
            name: 'turn_off_all_lights',
            description: 'Éteint TOUTES les lumières Hue en une fois.',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
        },
        {
            name: 'turn_on_all_lights',
            description: 'Allume TOUTES les lumières Hue. Paramètre brightness optionnel (0-100 %).',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    brightness: {
                        type: 'number',
                        description: 'Luminosité optionnelle (0-100 %)',
                        minimum: 0,
                        maximum: 100,
                    },
                },
                required: [],
            },
        },

        // ── Room or individual light — state (on/off/brightness/color) ────────
        {
            name: 'set_lights',
            description:
                `Allume, éteint ou règle la luminosité d'une pièce ou d'une lampe individuelle. ` +
                `Pour une couleur dans une pièce entière, utiliser set_room_palette à la place. ` +
                `Pièces : ${roomList}. Lampes : ${lightList}. ` +
                `Exemples : set_lights("Chambre", on=false) · set_lights("Salon", brightness=30) · set_lights("Lampe bureau", color="#FF8800", brightness=60).`,
            inputSchema: {
                type: 'object' as const,
                properties: {
                    target: {
                        type: 'string',
                        description: `Nom de la pièce (${roomList}) ou d'une lampe individuelle (${lightList})`,
                    },
                    on: {
                        type: 'boolean',
                        description: 'Allumer (true) ou éteindre (false). Défaut : true si brightness est précisé.',
                    },
                    brightness: {
                        type: 'number',
                        description: 'Luminosité 0-100 %',
                        minimum: 0,
                        maximum: 100,
                    },
                    color: {
                        type: 'string',
                        description: 'Couleur hex pour une lampe individuelle, ex : "#FF5500". Pour une pièce, utiliser set_room_palette.',
                    },
                },
                required: ['target'],
            },
        },

        // ── Room palette — color atmosphere ───────────────────────────────────
        {
            name: 'set_room_palette',
            description:
                `Applique une palette de couleurs dans une pièce : chaque lampe reçoit une teinte différente (distribution cyclique). ` +
                `Idéal pour les ambiances, soirées, cinéma — évite l'effet "toutes les lampes identiques". ` +
                `Pièces : ${roomList}. ` +
                `Exemples : set_room_palette("Salon", ["#FF6600","#CC3300","#880000"], brightness=40) pour une ambiance rouge chaude.`,
            inputSchema: {
                type: 'object' as const,
                properties: {
                    room: {
                        type: 'string',
                        description: `Nom de la pièce — ${roomList}`,
                    },
                    colors: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Tableau de couleurs hex distribuées cycliquement entre les lampes. Ex : ["#FF6600","#CC3300","#880000"].',
                        minItems: 1,
                    },
                    brightness: {
                        type: 'number',
                        description: 'Luminosité 0-100 % (optionnel)',
                        minimum: 0,
                        maximum: 100,
                    },
                },
                required: ['room', 'colors'],
            },
        },

        // ── Diagnostics ───────────────────────────────────────────────────────
        {
            name: 'list_lights',
            description:
                'Liste toutes les lumières avec leur ID, nom, pièce et état actuel. ' +
                'Utile pour diagnostiquer ou vérifier l\'état — pas nécessaire pour contrôler.',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
        },
        {
            name: 'refresh_lights',
            description: 'Force la re-découverte de toutes les lumières depuis le bridge Hue.',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
        },
    ];
}

/** Static default — used before room cache is ready. */
export const HUE_TOOLS = buildHueTools([]);
