/**
 * Build the Hue MCP tool definitions.
 * Room names are injected at startup from the cached Hue group list so the
 * LLM can call set_room_lights("Chambre", ...) without a prior list_lights.
 */
export function buildHueTools(roomNames: string[]) {
    const roomList = roomNames.length > 0 ? roomNames.join(', ') : '(chargement…)';

    return [
        // ── Primary high-level tool ───────────────────────────────────────────
        {
            name: 'set_room_lights',
            description:
                `Contrôle toutes les lumières d'une pièce en un seul appel (allumer, éteindre, luminosité, couleur). ` +
                `Pièces disponibles : ${roomList}. ` +
                `Exemples : set_room_lights("Chambre", on=false) · set_room_lights("Salon", brightness=30) · set_room_lights("Cuisine", color="#FF8800", brightness=80).`,
            inputSchema: {
                type: 'object' as const,
                properties: {
                    room: {
                        type: 'string',
                        description: `Nom de la pièce — valeurs acceptées : ${roomList}`,
                    },
                    on: {
                        type: 'boolean',
                        description:
                            'Allumer (true) ou éteindre (false). Optionnel si brightness ou color sont précisés (défaut : true).',
                    },
                    brightness: {
                        type: 'number',
                        description: 'Luminosité de 0 à 100 %',
                        minimum: 0,
                        maximum: 100,
                    },
                    color: {
                        type: 'string',
                        description: 'Couleur en hexadécimal, ex : "#FF5500"',
                    },
                },
                required: ['room'],
            },
        },

        // ── Bulk all-lights ───────────────────────────────────────────────────
        {
            name: 'turn_off_all_lights',
            description: 'Éteint TOUTES les lumières Hue en une fois. Préférer set_room_lights pour une pièce spécifique.',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
        },
        {
            name: 'turn_on_all_lights',
            description: 'Allume TOUTES les lumières Hue. Paramètre brightness optionnel (0-254).',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    brightness: {
                        type: 'number',
                        description: 'Luminosité optionnelle (0-254)',
                        minimum: 0,
                        maximum: 254,
                    },
                },
                required: [],
            },
        },

        // ── Individual light control (for precise per-light ops) ──────────────
        {
            name: 'list_lights',
            description:
                'Liste toutes les lumières avec leur ID, nom, pièce et état actuel. ' +
                'Utile pour connaître l\'état précis ou pour cibler une lumière individuelle. ' +
                'NE PAS utiliser juste pour contrôler une pièce — utiliser set_room_lights à la place.',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
        },
        {
            name: 'turn_on_light',
            description: 'Allume une lumière Hue par son ID numérique. Utiliser list_lights pour obtenir les IDs.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    lightId: { type: 'number', description: 'ID numérique de la lumière' },
                },
                required: ['lightId'],
            },
        },
        {
            name: 'turn_off_light',
            description: 'Éteint une lumière Hue par son ID numérique.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    lightId: { type: 'number', description: 'ID numérique de la lumière' },
                },
                required: ['lightId'],
            },
        },
        {
            name: 'set_brightness',
            description: 'Règle la luminosité d\'une lumière individuelle (0-254) par son ID. Pour une pièce entière, utiliser set_room_lights.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    lightId: { type: 'number', description: 'ID numérique de la lumière' },
                    brightness: {
                        type: 'number',
                        description: 'Luminosité 0 (min) à 254 (max)',
                        minimum: 0,
                        maximum: 254,
                    },
                },
                required: ['lightId', 'brightness'],
            },
        },
        {
            name: 'set_color',
            description: 'Règle la couleur d\'une lumière individuelle (hex). Pour une pièce entière, utiliser set_room_lights.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    lightId: { type: 'number', description: 'ID numérique de la lumière' },
                    color: { type: 'string', description: 'Hex, ex : "#FF5500"' },
                },
                required: ['lightId', 'color'],
            },
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
