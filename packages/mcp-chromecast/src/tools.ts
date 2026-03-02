const CHROMECAST_NOTE =
    'Always call tv_prepare_chromecast first to ensure the TV is on and set to HDMI3.';

export const CHROMECAST_TOOLS = [
    {
        name: 'cast_youtube',
        description:
            `Cast a YouTube video to the Chromecast (10.0.0.140). ${CHROMECAST_NOTE} ` +
            'Accepts a YouTube URL (youtube.com/watch?v=…, youtu.be/…), ' +
            'a YouTube video ID (11-char), or a natural-language search query ' +
            '(e.g. "lofi hip hop live", "official breaking bad trailer"). ' +
            'Results are cached locally after the first search.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                source: {
                    type: 'string',
                    description: 'YouTube URL, video ID, or search query',
                },
            },
            required: ['source'],
        },
    },
    {
        name: 'cast_netflix',
        description:
            `Launch Netflix on the Chromecast (10.0.0.140). ${CHROMECAST_NOTE} ` +
            'If a title is provided, attempts to deep-link directly to that movie or series ' +
            'via the DIAL protocol (content ID resolved via JustWatch, cached locally). ' +
            'Without a title, simply opens the Netflix app.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: {
                    type: 'string',
                    description: 'Movie or series title to open directly (e.g. "Breaking Bad", "Stranger Things")',
                },
            },
            required: [],
        },
    },
    {
        name: 'cast_crunchyroll',
        description:
            `Launch Crunchyroll on the Chromecast (10.0.0.140). ${CHROMECAST_NOTE} ` +
            'If a title is provided, attempts to deep-link to that anime or series. ' +
            'Without a title, simply opens the Crunchyroll app.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: {
                    type: 'string',
                    description: 'Anime or series title (e.g. "Attack on Titan", "Demon Slayer")',
                },
            },
            required: [],
        },
    },
    {
        name: 'cast_disney',
        description:
            `Launch Disney+ on the Chromecast (10.0.0.140). ${CHROMECAST_NOTE} ` +
            'If a title is provided, attempts to deep-link to that movie or series. ' +
            'Without a title, simply opens the Disney+ app.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: {
                    type: 'string',
                    description: 'Movie or series title (e.g. "The Mandalorian", "Loki")',
                },
            },
            required: [],
        },
    },
    {
        name: 'cast_prime',
        description:
            `Launch Prime Video on the Chromecast (10.0.0.140). ${CHROMECAST_NOTE} ` +
            'If a title is provided, attempts to deep-link to that movie or series. ' +
            'Without a title, simply opens the Prime Video app.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: {
                    type: 'string',
                    description: 'Movie or series title (e.g. "The Boys", "Reacher")',
                },
            },
            required: [],
        },
    },
    {
        name: 'cast_media',
        description:
            `Cast a direct media URL (mp4, m3u8, webm, mp3…) to the Chromecast (10.0.0.140). ${CHROMECAST_NOTE}`,
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
        description: 'Stop current playback on the Chromecast (10.0.0.140) and quit the active app.',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
];
