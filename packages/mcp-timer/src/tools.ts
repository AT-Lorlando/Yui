export const TIMER_TOOLS = [
    {
        name: 'timer_set',
        description: 'Créer un minuteur countdown. À la fin : clignotement lumières + annonce vocale. Idéal pour cuisine, médicaments, etc.',
        inputSchema: {
            type: 'object',
            properties: {
                label: {
                    type: 'string',
                    description: 'Nom du minuteur (ex: "pâtes", "pizza", "médicaments")',
                },
                duration_seconds: {
                    type: 'number',
                    description: 'Durée en secondes (ex: 600 = 10 minutes)',
                },
                room: {
                    type: 'string',
                    description: 'Pièce dont les lumières clignotent à la fin (ex: "cuisine", "salon"). Optionnel — sans room = pas de clignotement.',
                },
            },
            required: ['label', 'duration_seconds'],
        },
    },
    {
        name: 'timer_cancel',
        description: 'Annuler un minuteur actif',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'ID du minuteur (depuis timer_list)' },
            },
            required: ['id'],
        },
    },
    {
        name: 'timer_list',
        description: 'Lister les minuteurs actifs avec le temps restant',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
];
