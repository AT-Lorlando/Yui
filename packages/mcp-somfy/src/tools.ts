export const SOMFY_TOOLS = [
    {
        name: 'list_covers',
        description:
            'Lister tous les volets, stores, pergolas et portails Somfy TaHoma avec leur position actuelle',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'open_cover',
        description:
            'Ouvrir un volet / store / portail Somfy (commande "vers position 0%"). ' +
            "IMPORTANT : appelle ce tool dès que l'utilisateur demande d'ouvrir, " +
            "SANS vérifier l'état actuel avec list_covers — la position rapportée par " +
            'list_covers est souvent stale (cache cloud Tahoma), tu pourrais croire ' +
            'à tort que le volet est déjà ouvert. La commande est idempotente.',
        inputSchema: {
            type: 'object',
            properties: {
                device: {
                    type: 'string',
                    description:
                        'Nom EXACT du device tel que retourné par list_covers (ex: "Terrasse"). ' +
                        "N'invente jamais de nom — si tu n'es pas sûr, appelle list_covers d'abord.",
                },
            },
            required: ['device'],
        },
    },
    {
        name: 'close_cover',
        description:
            'Fermer un volet / store / portail Somfy (commande "vers position 100%"). ' +
            "IMPORTANT : appelle ce tool dès que l'utilisateur demande de fermer, " +
            "SANS vérifier l'état actuel avec list_covers — la position rapportée par " +
            'list_covers est souvent stale. La commande est idempotente.',
        inputSchema: {
            type: 'object',
            properties: {
                device: {
                    type: 'string',
                    description:
                        'Nom EXACT du device tel que retourné par list_covers (ex: "Terrasse"). ' +
                        "N'invente jamais de nom — si tu n'es pas sûr, appelle list_covers d'abord.",
                },
            },
            required: ['device'],
        },
    },
    {
        name: 'set_cover_position',
        description:
            "Régler la position d'un volet Somfy (0 = ouvert, 100 = fermé). Uniquement pour les devices IO (pas RTS).",
        inputSchema: {
            type: 'object',
            properties: {
                device: {
                    type: 'string',
                    description: 'Nom ou URL du device',
                },
                position: {
                    type: 'number',
                    description: 'Position 0–100 (0 = ouvert, 100 = fermé)',
                    minimum: 0,
                    maximum: 100,
                },
            },
            required: ['device', 'position'],
        },
    },
    {
        name: 'stop_cover',
        description: "Stopper le mouvement en cours d'un volet Somfy",
        inputSchema: {
            type: 'object',
            properties: {
                device: {
                    type: 'string',
                    description: 'Nom ou URL du device',
                },
            },
            required: ['device'],
        },
    },
    {
        name: 'my_position',
        description:
            'Envoyer un volet Somfy à sa position "My" (position mémorisée sur la télécommande)',
        inputSchema: {
            type: 'object',
            properties: {
                device: {
                    type: 'string',
                    description: 'Nom ou URL du device',
                },
            },
            required: ['device'],
        },
    },
    {
        name: 'refresh_covers',
        description:
            'Rafraîchir la liste des volets depuis le hub TaHoma (utile si un nouveau device a été ajouté)',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
];
