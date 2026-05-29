export const CHROMECAST_TOOLS = [
    // ── Cast tools (TV auto-prep is done internally) ──────────────────────────
    {
        name: 'cast_youtube',
        description:
            'Cast a YouTube video to the Chromecast, or open YouTube in browse mode. ' +
            'TV turns on and switches to HDMI3 automatically. ' +
            'Accepts a YouTube URL, video ID, or natural-language search query. ' +
            'Omit source to open YouTube in browse mode (no specific video).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                source: { type: 'string', description: 'YouTube URL, video ID, or search query. Omit for browse mode.' },
            },
            required: [],
        },
    },
    {
        name: 'cast_netflix',
        description:
            'Launch Netflix on the Chromecast. TV turns on and switches to HDMI3 automatically. ' +
            'Optionally deep-link to a specific title.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: { type: 'string', description: 'Movie or series title (e.g. "Breaking Bad")' },
            },
            required: [],
        },
    },
    {
        name: 'cast_crunchyroll',
        description:
            'Launch Crunchyroll on the Chromecast. TV turns on and switches to HDMI3 automatically. ' +
            'Optionally deep-link to a specific anime.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: { type: 'string', description: 'Anime or series title (e.g. "Demon Slayer")' },
            },
            required: [],
        },
    },
    {
        name: 'cast_disney',
        description:
            'Launch Disney+ on the Chromecast. TV turns on and switches to HDMI3 automatically. ' +
            'Optionally deep-link to a specific title.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: { type: 'string', description: 'Movie or series title (e.g. "The Mandalorian")' },
            },
            required: [],
        },
    },
    {
        name: 'cast_prime',
        description:
            'Launch Prime Video on the Chromecast. TV turns on and switches to HDMI3 automatically. ' +
            'Optionally deep-link to a specific title.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: { type: 'string', description: 'Movie or series title (e.g. "The Boys")' },
            },
            required: [],
        },
    },
    {
        name: 'cast_media',
        description: 'Cast a direct media URL (mp4, m3u8, mp3…) to the Chromecast. TV turns on automatically.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                url: { type: 'string', description: 'Direct media URL to cast' },
            },
            required: ['url'],
        },
    },
    {
        name: 'cast_stop',
        description: 'Stop current Chromecast playback without turning off the TV.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'find_show',
        description:
            'Trouver sur quelle plateforme de streaming regarder une série, un film ou un animé ' +
            '(Netflix, Crunchyroll, Disney+, Prime Video). Renvoie la plateforme. ' +
            'Appelle ensuite cast_<plateforme> avec le titre pour lancer la lecture. ' +
            'Utilise cet outil quand tu ne connais pas déjà la plateforme du titre demandé.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: { type: 'string', description: 'Titre de la série, film ou animé (ex: "Naruto")' },
            },
            required: ['title'],
        },
    },
    {
        name: 'remember_show',
        description:
            "Mémoriser sur quelle plateforme se trouve une série/film/animé, pour les prochaines fois. " +
            "Utilise quand l'utilisateur t'apprend où regarder un titre (ex: \"Naruto c'est sur Crunchyroll\").",
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: { type: 'string', description: 'Titre du contenu' },
                platform: {
                    type: 'string',
                    enum: ['crunchyroll', 'netflix', 'disney', 'prime'],
                    description: 'Plateforme de streaming',
                },
            },
            required: ['title', 'platform'],
        },
    },

    // ── TV power & controls ───────────────────────────────────────────────────
    {
        name: 'tv_on',
        description: 'Turn on the TV via Wake-on-LAN and switch to Chromecast input (HDMI3). Use when the user wants to turn on the TV without casting anything yet.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'tv_off',
        description: 'Stop Chromecast playback and turn off the TV. Call this when the user wants to turn off the TV or stop everything on the TV.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'tv_volume',
        description: 'Set the TV volume (0–100).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                level: { type: 'number', minimum: 0, maximum: 100, description: 'Volume level 0–100' },
            },
            required: ['level'],
        },
    },
    // ── Media library (hidden from LLM — orchestrator/scenes only) ───────────
    {
        name: 'list_media',
        description: 'Lister les médias locaux disponibles (wallpapers, vidéos).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                type: { type: 'string', enum: ['wallpaper', 'video', 'all'] },
            },
            required: [],
        },
    },
    {
        name: 'cast_wallpaper',
        description: 'Caster un fond d\'écran local sur le Chromecast. Sans argument = aléatoire.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                file: { type: 'string', description: 'Nom du fichier (ex: "photo.jpg"). Optionnel.' },
            },
            required: [],
        },
    },
    {
        name: 'cast_video',
        description: 'Caster une vidéo locale sur le Chromecast. Sans argument = aléatoire.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                file: { type: 'string', description: 'Nom du fichier (ex: "film.mp4"). Optionnel.' },
            },
            required: [],
        },
    },

    {
        name: 'tv_mute',
        description: 'Mute or unmute the TV.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                mute: { type: 'boolean', description: 'true to mute, false to unmute' },
            },
            required: ['mute'],
        },
    },
];
