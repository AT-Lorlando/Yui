export const SPOTIFY_TOOLS = [
    {
        name: 'list_speakers',
        description:
            'List all discovered speakers on the local network with their Spotify connection status',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'play_music',
        description:
            'Play or resume music on the default speaker. Can play a track by search query or Spotify URI. ' +
            'For albums use play_album, for playlists use play_playlist, for artist radio use play_artist_radio.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Track search query (e.g. "Bohemian Rhapsody Queen")',
                },
                uri: {
                    type: 'string',
                    description:
                        'Spotify URI to play directly (spotify:track:xxx, spotify:album:xxx, spotify:playlist:xxx)',
                },
            },
            required: [],
        },
    },
    {
        name: 'play_album',
        description:
            'Search for an album and play it in full on the default speaker.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Album search query (e.g. "Random Access Memories Daft Punk")',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'play_playlist',
        description:
            "Search the user's saved playlists first, then Spotify's catalog, and play the best match on the default speaker.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Playlist name or search query (e.g. "chill", "workout", "indie")',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'play_artist_radio',
        description:
            'Play a Spotify radio / recommendations mix seeded by an artist on the default speaker.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                artist: {
                    type: 'string',
                    description: 'Artist name (e.g. "Daft Punk", "Bonobo")',
                },
            },
            required: ['artist'],
        },
    },
    {
        name: 'pause_music',
        description:
            'Pause playback temporarily — amplifier stays on for quick resume.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'stop_music',
        description:
            'Stop music entirely: pauses Spotify and turns off the amplifier. Use when the user is done listening, not for a temporary pause.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'next_track',
        description: 'Skip to the next track',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'previous_track',
        description: 'Skip to the previous track',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'set_volume',
        description: 'Set the playback volume (0–100)',
        inputSchema: {
            type: 'object' as const,
            properties: {
                percent: {
                    type: 'number',
                    description: 'Volume level 0–100',
                    minimum: 0,
                    maximum: 100,
                },
            },
            required: ['percent'],
        },
    },
    {
        name: 'set_shuffle',
        description: 'Enable or disable shuffle mode',
        inputSchema: {
            type: 'object' as const,
            properties: {
                enabled: {
                    type: 'boolean',
                    description: 'true to enable shuffle, false to disable',
                },
            },
            required: ['enabled'],
        },
    },
    {
        name: 'set_repeat',
        description:
            'Set repeat mode: off, track (repeat current track), or context (repeat album/playlist)',
        inputSchema: {
            type: 'object' as const,
            properties: {
                mode: {
                    type: 'string',
                    enum: ['off', 'track', 'context'],
                    description: 'Repeat mode',
                },
            },
            required: ['mode'],
        },
    },
    {
        name: 'add_to_queue',
        description:
            'Add a track to the playback queue. Searches if a query is given.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: {
                    type: 'string',
                    description: 'Track search query to queue',
                },
                uri: {
                    type: 'string',
                    description: 'Spotify track URI to queue directly',
                },
            },
            required: [],
        },
    },
    {
        name: 'get_playback_state',
        description:
            'Get the current playback state: track, artist, album, progress, device, shuffle, repeat',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'search_music',
        description:
            'Search Spotify for tracks, albums, playlists, or artists. Returns up to 10 results with URIs.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: { type: 'string', description: 'Search query' },
                type: {
                    type: 'string',
                    description: 'Content type to search',
                    enum: ['track', 'album', 'playlist', 'artist'],
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'get_my_playlists',
        description: "List the user's saved Spotify playlists (up to 50)",
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'refresh_speakers',
        description:
            'Re-discover speakers on the local network via Bonjour and match with Spotify Connect devices',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'amp_off',
        description:
            "Éteint l'ampli Marantz SR4500 via le Broadlink RM4 Pro (idempotent — ne refait rien si déjà éteint).",
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'amp_on',
        description:
            "Allume l'ampli Marantz SR4500 via le Broadlink RM4 Pro (idempotent).",
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
];
