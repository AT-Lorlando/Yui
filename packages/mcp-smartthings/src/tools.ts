// packages/mcp-smartthings/src/tools.ts
import { loadTvConfig } from '@yui/shared';

export function buildSmartThingsTools(inputs: string[]) {
    return [
        {
            name: 'tv_on',
            description:
                'Allumer la TV (Wake-on-LAN) et basculer sur le Chromecast. ' +
                'À utiliser quand on veut la TV allumée sans rien lancer.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
                required: [],
            },
        },
        {
            name: 'tv_off',
            description: 'Éteindre la TV.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
                required: [],
            },
        },
        {
            name: 'tv_volume',
            description: 'Régler le volume de la TV (0–100).',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    level: {
                        type: 'number',
                        minimum: 0,
                        maximum: 100,
                        description: 'Niveau de volume 0–100',
                    },
                },
                required: ['level'],
            },
        },
        {
            name: 'tv_mute',
            description: 'Couper ou rétablir le son de la TV.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    mute: {
                        type: 'boolean',
                        description: 'true pour couper, false pour rétablir',
                    },
                },
                required: ['mute'],
            },
        },
        {
            name: 'tv_set_input',
            description: "Changer l'entrée de la TV.",
            inputSchema: {
                type: 'object' as const,
                properties: {
                    source: {
                        type: 'string',
                        enum: inputs,
                        description: 'Entrée cible (ex: HDMI3 = Chromecast)',
                    },
                },
                required: ['source'],
            },
        },
        {
            name: 'tv_status',
            description:
                'État de la TV : allumée/éteinte, volume, sourdine, entrée active.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
                required: [],
            },
        },
        {
            // Caché du LLM (voir LLM_HIDDEN_TOOLS) — variante structurée de tv_status
            // pour le dashboard : renvoie du JSON { power, volume, muted, input, inputs }.
            name: 'tv_get_status',
            description:
                'État TV structuré (JSON) pour le dashboard : { power, volume, muted, input, inputs }.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
                required: [],
            },
        },
    ];
}

export const SMARTTHINGS_TOOLS = buildSmartThingsTools(
    Object.keys(loadTvConfig().inputs),
);
