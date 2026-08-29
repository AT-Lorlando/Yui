/**
 * Build the Hue MCP tool definitions.
 * Room and light names are injected at startup so the LLM never needs list_lights.
 *
 * Tool decision guide:
 *   turn_on/off_all_lights   — whole flat
 *   set_lights(target, ...)  — on/off/brightness for a room OR any state for one light
 *   set_room_palette(room, colors[]) — color atmosphere for a room (each light gets a different shade)
 */
export function buildHueTools(
    roomNames: string[],
    lightNames: string[] = [],
    goveeNames: string[] = [],
) {
    const roomList =
        roomNames.length > 0 ? roomNames.join(', ') : '(chargement…)';
    const lightList =
        lightNames.length > 0 ? lightNames.join(', ') : '(chargement…)';
    // Enum on the LLM-facing tools too: it stops the model inventing room
    // names, and the app renders a select instead of a free-text field.
    // Une pièce et une lampe peuvent porter le même nom ("Couloir") — dédupliqué
    // pour ne pas proposer deux fois la même valeur dans le select.
    const targets = [...new Set([...roomNames, ...lightNames])];
    const enumOf = (values: string[]) =>
        values.length ? { enum: values } : {};

    return [
        // ── Whole flat ────────────────────────────────────────────────────────
        {
            name: 'turn_off_all_lights',
            description: 'Éteint TOUTES les lumières Hue en une fois.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
                required: [],
            },
        },
        {
            name: 'turn_on_all_lights',
            description:
                'Allume TOUTES les lumières Hue. Paramètre brightness optionnel (0-100 %).',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    brightness: {
                        type: 'number',
                        title: 'Luminosité',
                        description: 'Luminosité optionnelle (0-100 %)',
                        minimum: 0,
                        maximum: 100,
                        'x-unit': '%',
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
                `Exemples : set_lights("Chambre", on=false) · set_lights("Salon", brightness=30) · ` +
                `set_lights("Salon", colorTemp=2700) pour un blanc chaud · ` +
                `set_lights("Salon", brightnessDelta=-20) pour "baisse un peu" · ` +
                `set_lights("Lampe bureau", color="#FF8800", brightness=60).`,
            inputSchema: {
                type: 'object' as const,
                properties: {
                    target: {
                        type: 'string',
                        title: 'Cible',
                        ...enumOf(targets),
                        description: `Nom de la pièce (${roomList}) ou d'une lampe individuelle (${lightList})`,
                    },
                    on: {
                        type: 'boolean',
                        title: 'Allumée',
                        description:
                            'Allumer (true) ou éteindre (false). Défaut : true si brightness est précisé.',
                    },
                    brightness: {
                        type: 'number',
                        title: 'Luminosité',
                        description: 'Luminosité 0-100 %',
                        minimum: 0,
                        maximum: 100,
                        'x-unit': '%',
                        'x-dynamic': ['time_brightness', 'random'],
                    },
                    brightnessDelta: {
                        type: 'number',
                        title: 'Variation',
                        description:
                            'Variation relative de luminosité en points de % ' +
                            '(-100 à 100). Pour "baisse un peu" (-20) / "monte un peu" (+20). ' +
                            "N'allume ni n'éteint les lampes. Exclusif avec brightness.",
                        minimum: -100,
                        maximum: 100,
                        'x-unit': '%',
                    },
                    color: {
                        type: 'string',
                        title: 'Couleur',
                        'x-widget': 'color',
                        description:
                            'Couleur hex pour une lampe individuelle, ex : "#FF5500". Pour une pièce, utiliser set_room_palette.',
                    },
                    colorTemp: {
                        type: 'number',
                        title: 'Blanc (K)',
                        description:
                            'Température de blanc en kelvin : 2700 = blanc chaud, ' +
                            '4000 = neutre, 6500 = blanc froid/lumière du jour. ' +
                            'À préférer à color pour toute demande de blanc. Prime sur color.',
                        minimum: 2000,
                        maximum: 6500,
                        'x-unit': 'K',
                    },
                    transitionMs: {
                        type: 'number',
                        title: 'Fondu (ms)',
                        description:
                            'Durée du fondu en ms (transition lente côté bridge). Ex: 4000 = fondu sur 4s.',
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
                        title: 'Pièce',
                        ...enumOf(roomNames),
                        description: `Nom de la pièce — ${roomList}`,
                    },
                    colors: {
                        type: 'array',
                        title: 'Palette',
                        items: { type: 'string', 'x-widget': 'color' },
                        description:
                            'Tableau de couleurs hex distribuées cycliquement entre les lampes. Ex : ["#FF6600","#CC3300","#880000"].',
                        minItems: 1,
                    },
                    brightness: {
                        type: 'number',
                        title: 'Luminosité',
                        description: 'Luminosité 0-100 % (optionnel)',
                        minimum: 0,
                        maximum: 100,
                        'x-unit': '%',
                    },
                    transitionMs: {
                        type: 'number',
                        title: 'Fondu (ms)',
                        description:
                            'Durée du fondu en ms. Ex: 4000 = fondu sur 4s.',
                    },
                },
                required: ['room', 'colors'],
            },
        },

        // ── Individual light by ID (used by the HTTP /devices API) ───────────
        {
            name: 'turn_on_light',
            description: 'Allume une lampe individuelle par son ID.',
            inputSchema: {
                type: 'object' as const,
                'x-audience': ['system'],
                properties: {
                    lightId: {
                        type: ['number', 'string'],
                        description:
                            'ID de la lampe — numérique (Hue) ou "g:N" (Govee)',
                    },
                },
                required: ['lightId'],
            },
        },
        {
            name: 'turn_off_light',
            description: 'Éteint une lampe individuelle par son ID.',
            inputSchema: {
                type: 'object' as const,
                'x-audience': ['system'],
                properties: {
                    lightId: {
                        type: ['number', 'string'],
                        description:
                            'ID de la lampe — numérique (Hue) ou "g:N" (Govee)',
                    },
                },
                required: ['lightId'],
            },
        },
        {
            name: 'set_brightness',
            description:
                "Règle la luminosité d'une lampe individuelle par son ID (0-100 %).",
            inputSchema: {
                type: 'object' as const,
                'x-audience': ['system'],
                properties: {
                    lightId: {
                        type: ['number', 'string'],
                        description:
                            'ID de la lampe — numérique (Hue) ou "g:N" (Govee)',
                    },
                    brightness: {
                        type: 'number',
                        minimum: 0,
                        maximum: 100,
                        description: 'Luminosité 0-100 %',
                    },
                },
                required: ['lightId', 'brightness'],
            },
        },
        {
            name: 'set_color',
            description:
                "Change la couleur d'une lampe individuelle par son ID.",
            inputSchema: {
                type: 'object' as const,
                'x-audience': ['system'],
                properties: {
                    lightId: {
                        type: ['number', 'string'],
                        description:
                            'ID de la lampe — numérique (Hue) ou "g:N" (Govee)',
                    },
                    color: {
                        type: 'string',
                        description: 'Couleur hex, ex : "#FF5500"',
                    },
                },
                required: ['lightId', 'color'],
            },
        },

        // ── Diagnostics ───────────────────────────────────────────────────────
        {
            name: 'list_lights',
            description:
                'Liste toutes les lumières avec leur ID, nom, pièce et état actuel. ' +
                "Utile pour diagnostiquer ou vérifier l'état — pas nécessaire pour contrôler.",
            inputSchema: {
                type: 'object' as const,
                'x-audience': ['llm'],
                properties: {
                    refresh: {
                        type: 'boolean',
                        title: 'Forcer la relecture',
                        description:
                            'Relit le bridge sans attendre le TTL de cache.',
                    },
                },
                required: [],
            },
        },
        {
            name: 'refresh_lights',
            description:
                'Force la re-découverte de toutes les lumières depuis le bridge Hue.',
            inputSchema: {
                type: 'object' as const,
                'x-audience': ['system'],
                properties: {},
                required: [],
            },
        },

        // ── Govee ambiance presets ────────────────────────────────────────────
        {
            name: 'govee_ambiance_start',
            description:
                'Lance une ambiance animée sur une lampe Govee (gradient cyclique ' +
                'de couleurs, pulse de luminosité). Presets : aurora, sunset, ocean, ' +
                'fire, rainbow, rave, lavande. À utiliser sur une lampe explicitement ' +
                'configurée en RGB (canal ambiance). Stoppe automatiquement toute ' +
                'animation précédente sur le même device.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    device: {
                        type: 'string',
                        title: 'Lampe Govee',
                        ...enumOf(goveeNames),
                        description:
                            'Nom de la lampe Govee (ex: "Govee Ambiance")',
                    },
                    preset: {
                        type: 'string',
                        title: 'Ambiance',
                        description: 'Identifiant du preset',
                        enum: [
                            'aurora',
                            'sunset',
                            'ocean',
                            'fire',
                            'rainbow',
                            'rave',
                            'lavande',
                        ],
                    },
                },
                required: ['device', 'preset'],
            },
        },
        {
            name: 'govee_ambiance_stop',
            description:
                "Arrête l'ambiance animée en cours sur une lampe Govee.",
            inputSchema: {
                type: 'object' as const,
                properties: {
                    device: {
                        type: 'string',
                        title: 'Lampe Govee',
                        ...enumOf(goveeNames),
                        description: 'Nom de la lampe Govee',
                    },
                },
                required: ['device'],
            },
        },
        {
            name: 'govee_ambiance_list',
            description: "Liste tous les presets d'ambiance Govee disponibles.",
            inputSchema: {
                type: 'object' as const,
                'x-audience': ['llm'],
                properties: {},
                required: [],
            },
        },
    ];
}

/** Static default — used before room cache is ready. */
export const HUE_TOOLS = buildHueTools([]);
