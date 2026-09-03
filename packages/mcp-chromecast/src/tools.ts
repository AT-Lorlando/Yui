import { CAST_APP_TOOL } from './castAppHandler';

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
                source: {
                    type: 'string',
                    description:
                        'YouTube URL, video ID, or search query. Omit for browse mode.',
                },
            },
            required: [],
        },
    },
    {
        name: 'cast_netflix',
        description:
            'Launch Netflix on the Chromecast. TV turns on and switches to HDMI3 automatically. ' +
            'IMPORTANT: if the user mentions a specific title (e.g. "lance Breaking Bad sur Netflix"), ' +
            'ALWAYS pass it in `title` so the deep-link opens the show directly. ' +
            'Omit `title` only when the user just says "lance Netflix" with no show.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: {
                    type: 'string',
                    description:
                        'Movie or series title mentioned by the user (e.g. "Breaking Bad")',
                },
            },
            required: [],
        },
    },
    {
        name: 'cast_crunchyroll',
        description:
            'Launch Crunchyroll on the Chromecast. TV turns on and switches to HDMI3 automatically. ' +
            'IMPORTANT: if the user mentions a specific anime (e.g. "lance Re:Zero", "lance One Piece"), ' +
            'ALWAYS pass it in `title` so the deep-link opens the anime directly. ' +
            'Omit `title` only when the user just says "lance Crunchyroll" with no anime.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: {
                    type: 'string',
                    description:
                        'Anime title mentioned by the user (e.g. "Re:Zero", "Demon Slayer")',
                },
            },
            required: [],
        },
    },
    {
        name: 'cast_disney',
        description:
            'Launch Disney+ on the Chromecast. TV turns on and switches to HDMI3 automatically. ' +
            'IMPORTANT: if the user mentions a specific title, ALWAYS pass it in `title`. ' +
            'Omit `title` only when the user just says "lance Disney" with no show.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: {
                    type: 'string',
                    description:
                        'Movie or series title mentioned by the user (e.g. "The Mandalorian")',
                },
            },
            required: [],
        },
    },
    {
        name: 'cast_prime',
        description:
            'Launch Prime Video on the Chromecast. TV turns on and switches to HDMI3 automatically. ' +
            'IMPORTANT: if the user mentions a specific title, ALWAYS pass it in `title`. ' +
            'Omit `title` only when the user just says "lance Prime" with no show.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: {
                    type: 'string',
                    description:
                        'Movie or series title mentioned by the user (e.g. "The Boys")',
                },
            },
            required: [],
        },
    },
    CAST_APP_TOOL,
    {
        name: 'cast_media',
        description:
            'Cast a direct media URL (mp4, m3u8, mp3…) to the Chromecast. TV turns on automatically.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                url: {
                    type: 'string',
                    description: 'Direct media URL to cast',
                },
            },
            required: ['url'],
        },
    },
    {
        name: 'cast_stop',
        description:
            'Stop current Chromecast playback without turning off the TV.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'cast_dashboard',
        description:
            "Afficher le tableau de bord (dashboard) sur la TV : lance l'app Fully Kiosk " +
            "sur la Google TV. La TV s'allume et bascule sur HDMI3 automatiquement. " +
            "Fully s'ouvre sur sa page de démarrage (le dashboard). À utiliser quand " +
            "l'utilisateur demande d'afficher le dashboard / tableau de bord / l'accueil " +
            'sur la télé, ou de lancer Fully.',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
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
                title: {
                    type: 'string',
                    description:
                        'Titre de la série, film ou animé (ex: "Naruto")',
                },
            },
            required: ['title'],
        },
    },
    {
        name: 'remember_show',
        description:
            'Mémoriser sur quelle plateforme se trouve une série/film/animé, pour les prochaines fois. ' +
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

    {
        name: 'tv_media',
        description:
            'Contrôle la lecture en cours sur la TV (Shield) : pause, lecture, ' +
            "stop, reculer/avancer — quelle que soit l'app (Prime, Netflix, " +
            'YouTube…). Pour « mets pause », « reprends la lecture » pendant ' +
            'un visionnage.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                action: {
                    type: 'string',
                    title: 'Action',
                    enum: [
                        'play_pause',
                        'pause',
                        'play',
                        'stop',
                        'rewind',
                        'forward',
                    ],
                    description:
                        'play_pause = bascule (défaut sûr si on ne sait pas)',
                },
            },
            required: ['action'],
        },
    },

    // ── Media library (hidden from LLM — orchestrator/scenes only) ───────────
    {
        name: 'list_media',
        description:
            'Lister les médias locaux disponibles (wallpapers, vidéos).',
        inputSchema: {
            type: 'object' as const,
            'x-audience': ['system'],
            properties: {
                type: { type: 'string', enum: ['wallpaper', 'video', 'all'] },
            },
            required: [],
        },
    },
    {
        name: 'cast_wallpaper',
        description:
            "Caster un fond d'écran local sur le Chromecast. Sans argument = aléatoire.",
        inputSchema: {
            type: 'object' as const,
            'x-audience': ['app'],
            properties: {
                file: {
                    type: 'string',
                    title: 'Fichier',
                    description: 'Nom du fichier (ex: "photo.jpg"). Optionnel.',
                },
            },
            required: [],
        },
    },
    {
        name: 'cast_video',
        description:
            'Caster une vidéo locale sur le Chromecast. Sans argument = aléatoire.',
        inputSchema: {
            type: 'object' as const,
            'x-audience': ['app'],
            properties: {
                file: {
                    type: 'string',
                    title: 'Fichier',
                    description: 'Nom du fichier (ex: "film.mp4"). Optionnel.',
                },
            },
            required: [],
        },
    },
];

/**
 * Same tools, with the media `file` fields turned into enums of what is
 * actually on disk. Built per tools/list call (a readdir is cheap) so dropping
 * a new wallpaper in assets/media shows up without restarting the server.
 */
export function buildChromecastTools(media: {
    wallpapers: string[];
    videos: string[];
}) {
    const files: Record<string, string[]> = {
        cast_wallpaper: media.wallpapers,
        cast_video: media.videos,
    };
    return CHROMECAST_TOOLS.map((tool) => {
        const values = files[tool.name];
        if (!values?.length) return tool;
        const props = tool.inputSchema.properties as Record<string, unknown>;
        return {
            ...tool,
            inputSchema: {
                ...tool.inputSchema,
                properties: {
                    ...props,
                    file: { ...(props.file as object), enum: values },
                },
            },
        };
    });
}
