/**
 * Build the Nuki MCP tool definitions.
 * Door names are injected at startup from the cached lock list so the
 * LLM can call control_door("Entrée", "unlock") without a prior list_doors.
 */
export function buildNukiTools(doorNames: string[]) {
    const doorList = doorNames.length > 0 ? doorNames.join(', ') : '(chargement…)';

    return [
        // ── Primary high-level tool ───────────────────────────────────────────
        {
            name: 'control_door',
            description:
                `Verrouille ou déverrouille une porte Nuki par son nom. ` +
                `Portes disponibles : ${doorList}. ` +
                `Exemples : control_door("Entrée", "unlock") · control_door("Garage", "lock").`,
            inputSchema: {
                type: 'object' as const,
                properties: {
                    name: {
                        type: 'string',
                        description: `Nom de la porte — valeurs acceptées : ${doorList}`,
                    },
                    action: {
                        type: 'string',
                        enum: ['lock', 'unlock'],
                        description: 'lock = verrouiller, unlock = déverrouiller',
                    },
                },
                required: ['name', 'action'],
            },
        },

        // ── Low-level tools (by nukiId) ───────────────────────────────────────
        {
            name: 'list_doors',
            description:
                'Liste toutes les portes Nuki avec leur état (verrouillé/déverrouillé, batterie). ' +
                'NE PAS utiliser juste pour contrôler une porte — utiliser control_door à la place.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
                required: [],
            },
        },
        {
            name: 'lock_door',
            description: 'Verrouille une porte Nuki par son ID numérique. Préférer control_door(name) pour un usage normal.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    nukiId: {
                        type: 'number',
                        description: 'The numeric ID of the Nuki smart lock',
                    },
                    deviceType: {
                        type: 'number',
                        description:
                            'Device type: 0=Smart Lock, 2=Opener, 4=Smart Lock 3.0 (default: 0)',
                    },
                },
                required: ['nukiId'],
            },
        },
        {
            name: 'unlock_door',
            description: 'Déverrouille une porte Nuki par son ID numérique. Préférer control_door(name) pour un usage normal.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    nukiId: {
                        type: 'number',
                        description: 'The numeric ID of the Nuki smart lock',
                    },
                    deviceType: {
                        type: 'number',
                        description:
                            'Device type: 0=Smart Lock, 2=Opener, 4=Smart Lock 3.0 (default: 0)',
                    },
                },
                required: ['nukiId'],
            },
        },
        {
            name: 'get_door_state',
            description:
                'Obtient l\'état détaillé d\'une porte Nuki (verrou, batterie, capteur de porte).',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    nukiId: {
                        type: 'number',
                        description: 'The numeric ID of the Nuki smart lock',
                    },
                    deviceType: {
                        type: 'number',
                        description:
                            'Device type: 0=Smart Lock, 2=Opener, 4=Smart Lock 3.0 (default: 0)',
                    },
                },
                required: ['nukiId'],
            },
        },
        {
            name: 'refresh_doors',
            description:
                'Force la re-découverte de toutes les portes Nuki depuis le bridge.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
                required: [],
            },
        },
    ];
}

/** Static default — used before door cache is ready. */
export const NUKI_TOOLS = buildNukiTools([]);
