/**
 * Nuki MCP tool definitions.
 * One door setup — no name or ID needed for lock/unlock.
 */
export function buildNukiTools(doorName?: string) {
    const name = doorName ?? 'la porte';

    return [
        {
            name: 'lock_door',
            description: `Verrouille ${name}. Aucun paramètre nécessaire.`,
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
        },
        {
            name: 'unlock_door',
            description: `Déverrouille ${name}. Aucun paramètre nécessaire.`,
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
        },
        {
            name: 'list_doors',
            description: 'Obtient l\'état actuel de la porte (verrouillé/déverrouillé, batterie).',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
        },
        {
            name: 'refresh_doors',
            description: 'Force la re-découverte des portes depuis le bridge Nuki.',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
        },
    ];
}

/** Static default — used before door cache is ready. */
export const NUKI_TOOLS = buildNukiTools();
