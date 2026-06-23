export const TV_INPUTS = ['HDMI1', 'HDMI2', 'HDMI3', 'TV', 'AV'] as const;

export const TV_INPUT_TOOL = {
    name: 'tv_input',
    description: "Change l'entrée de la TV. Caché du LLM — pour l'éditeur.",
    inputSchema: {
        type: 'object' as const,
        properties: {
            source: {
                type: 'string',
                enum: [...TV_INPUTS],
                description: 'Entrée TV.',
            },
        },
        required: ['source'],
    },
};

export function isValidInput(source: string): boolean {
    return (TV_INPUTS as readonly string[]).includes(source);
}
