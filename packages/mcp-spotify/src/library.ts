import type SpotifyWebApi from 'spotify-web-api-node';
import Logger from './logger';
import { describeError, fail, json, text } from './types';
import type {
    ToolContext,
    ToolDefinition,
    ToolHandler,
    ToolModule,
} from './types';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in library.test.ts)
// ---------------------------------------------------------------------------

export type SpotifyKind = 'track' | 'album' | 'artist' | 'playlist';

const OPEN_URL_RE =
    /^(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?\/)?(?:embed\/)?(track|album|artist|playlist)\/([A-Za-z0-9]+)/i;
const URI_RE = /^spotify:(track|album|artist|playlist):([A-Za-z0-9]+)$/i;
const RAW_ID_RE = /^[A-Za-z0-9]{22}$/;

/**
 * Normalise a Spotify reference (bare id, `spotify:<kind>:<id>` URI or
 * open.spotify.com URL) to a bare id. Throws when the reference is of another
 * kind (a playlist URI passed to save_tracks) or unparseable.
 */
export function toId(kind: SpotifyKind, value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error(
            `Référence ${kind} invalide : ${JSON.stringify(value)}`,
        );
    }
    const raw = value.trim();
    let found: { kind: string; id: string } | undefined;
    const uri = raw.match(URI_RE);
    if (uri) found = { kind: uri[1].toLowerCase(), id: uri[2] };
    const url = raw.match(OPEN_URL_RE);
    if (!found && url) found = { kind: url[1].toLowerCase(), id: url[2] };
    if (found) {
        if (found.kind !== kind) {
            throw new Error(`"${raw}" est un ${found.kind}, pas un ${kind}`);
        }
        return found.id;
    }
    if (RAW_ID_RE.test(raw)) return raw;
    throw new Error(
        `Référence ${kind} invalide : "${raw}" (attendu un id, spotify:${kind}:… ou une URL open.spotify.com)`,
    );
}

export const toUri = (kind: SpotifyKind, id: string): string =>
    `spotify:${kind}:${id}`;

/** Split an array in consecutive slices of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
    if (size < 1) throw new Error('chunk size must be >= 1');
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size)
        out.push(items.slice(i, i + size));
    return out;
}

/** Coerce a numeric arg into [min, max], falling back to `def`. */
export function clampInt(
    value: unknown,
    def: number,
    min: number,
    max: number,
): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function stringList(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') return value.trim() ? [value] : [];
    if (Array.isArray(value))
        return value.filter(
            (v): v is string => typeof v === 'string' && v.trim() !== '',
        );
    return [];
}

const TRACK_CHUNK = 50;
const ALBUM_CHUNK = 20;
const ARTIST_CHUNK = 50;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const artistNames = (artists: Array<{ name: string }> | undefined): string =>
    (artists ?? []).map((a) => a.name).join(', ');

function formatTrack(
    t: SpotifyApi.TrackObjectFull | SpotifyApi.TrackObjectSimplified,
) {
    const album = (t as SpotifyApi.TrackObjectFull).album;
    return {
        name: t.name,
        artist: artistNames(t.artists),
        album: album?.name ?? null,
        uri: t.uri,
    };
}

// ---------------------------------------------------------------------------
// Shared resolution steps
// ---------------------------------------------------------------------------

/** Id + label of the track currently playing, or an error message. */
async function currentTrack(
    api: SpotifyWebApi,
): Promise<{ id: string; label: string } | { error: string }> {
    const res = await api.getMyCurrentPlayingTrack();
    const body = res.body as SpotifyApi.CurrentlyPlayingResponse | undefined;
    const item = body?.item;
    if (
        !body ||
        !item ||
        body.currently_playing_type !== 'track' ||
        !('artists' in item)
    ) {
        return {
            error: "Rien ne joue actuellement sur Spotify (ou ce n'est pas un titre).",
        };
    }
    const track = item as SpotifyApi.TrackObjectFull;
    return {
        id: track.id,
        label: `${track.name} — ${artistNames(track.artists)}`,
    };
}

interface Resolution {
    query: string;
    id?: string;
    label?: string;
    error?: string;
}

async function resolveTrackQuery(
    api: SpotifyWebApi,
    query: string,
): Promise<Resolution> {
    try {
        const res = await api.search(query, ['track'], { limit: 1 });
        const hit = res.body.tracks?.items?.[0];
        if (!hit) return { query, error: 'aucun résultat' };
        return {
            query,
            id: hit.id,
            label: `${hit.name} — ${artistNames(hit.artists)}`,
        };
    } catch (err) {
        return { query, error: describeError(err) };
    }
}

async function resolveArtistName(
    api: SpotifyWebApi,
    name: string,
): Promise<Resolution> {
    try {
        const res = await api.search(name, ['artist'], { limit: 1 });
        const hit = res.body.artists?.items?.[0];
        if (!hit) return { query: name, error: 'aucun résultat' };
        return { query: name, id: hit.id, label: hit.name };
    } catch (err) {
        return { query: name, error: describeError(err) };
    }
}

/**
 * Collect track ids from `uris` + `queries`; with neither, use the currently
 * playing track. Returns ids, human labels, and per-query resolution notes.
 */
async function collectTrackIds(
    api: SpotifyWebApi,
    args: Record<string, unknown>,
): Promise<{ ids: string[]; notes: string[] } | { error: string }> {
    const uris = stringList(args.uris);
    const queries = stringList(args.queries);
    const notes: string[] = [];
    const ids: string[] = [];

    if (uris.length === 0 && queries.length === 0) {
        const cur = await currentTrack(api);
        if ('error' in cur) return cur;
        ids.push(cur.id);
        notes.push(`titre en cours : ${cur.label}`);
        return { ids, notes };
    }

    for (const u of uris) {
        try {
            ids.push(toId('track', u));
        } catch (err) {
            return { error: (err as Error).message };
        }
    }
    for (const q of queries) {
        const r = await resolveTrackQuery(api, q);
        if (r.id) {
            ids.push(r.id);
            notes.push(`"${q}" → ${r.label}`);
        } else {
            notes.push(`"${q}" → introuvable (${r.error})`);
        }
    }
    if (ids.length === 0)
        return { error: `Aucun titre résolu. ${notes.join(' ; ')}` };
    return { ids: Array.from(new Set(ids)), notes };
}

async function collectArtistIds(
    api: SpotifyWebApi,
    args: Record<string, unknown>,
): Promise<{ ids: string[]; notes: string[] } | { error: string }> {
    const uris = stringList(args.uris);
    const names = stringList(args.names);
    if (uris.length === 0 && names.length === 0) {
        return { error: 'Donne au moins un artiste (uris ou names).' };
    }
    const ids: string[] = [];
    const notes: string[] = [];
    for (const u of uris) {
        try {
            ids.push(toId('artist', u));
        } catch (err) {
            return { error: (err as Error).message };
        }
    }
    for (const n of names) {
        const r = await resolveArtistName(api, n);
        if (r.id) {
            ids.push(r.id);
            notes.push(`"${n}" → ${r.label}`);
        } else {
            notes.push(`"${n}" → introuvable (${r.error})`);
        }
    }
    if (ids.length === 0)
        return { error: `Aucun artiste résolu. ${notes.join(' ; ')}` };
    return { ids: Array.from(new Set(ids)), notes };
}

function parseAlbumIds(
    args: Record<string, unknown>,
): { ids: string[] } | { error: string } {
    const uris = stringList(args.uris);
    if (uris.length === 0)
        return { error: 'uris est requis (ids ou spotify:album:… URIs).' };
    try {
        return { ids: Array.from(new Set(uris.map((u) => toId('album', u)))) };
    } catch (err) {
        return { error: (err as Error).message };
    }
}

const summary = (verb: string, count: number, notes: string[]): string =>
    `${verb} ${count} élément${count > 1 ? 's' : ''}.${
        notes.length ? '\n' + notes.join('\n') : ''
    }`;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TIME_RANGE_DESC =
    'Période : "short_term" ≈ les 4 dernières semaines, "medium_term" ≈ les 6 derniers mois (défaut), "long_term" ≈ plusieurs années d\'écoute.';

const tools: ToolDefinition[] = [
    {
        name: 'save_tracks',
        description:
            'Ajoute des titres aux "Titres likés" de l\'utilisateur. Sans AUCUN argument, like le titre en cours de lecture (erreur si rien ne joue). ' +
            'uris accepte des ids ou des URIs spotify:track:… ; queries sont des recherches libres ("titre artiste") résolues au premier résultat. ' +
            'Idempotent : un titre déjà liké le reste.',
        inputSchema: {
            type: 'object',
            properties: {
                uris: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Ids, URIs spotify:track:… ou URLs open.spotify.com/track/… à liker.',
                },
                queries: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Recherches libres, ex. "Blinding Lights The Weeknd" — chaque entrée est résolue au premier résultat.',
                },
            },
        },
    },
    {
        name: 'remove_saved_tracks',
        description:
            'Retire des titres des "Titres likés". Sans AUCUN argument, retire le titre en cours de lecture (erreur si rien ne joue). ' +
            'uris accepte des ids, des URIs spotify:track:… ou des URLs open.spotify.com.',
        inputSchema: {
            type: 'object',
            properties: {
                uris: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Ids, URIs spotify:track:… ou URLs open.spotify.com/track/… à retirer des likes.',
                },
            },
        },
    },
    {
        name: 'get_saved_tracks',
        description:
            'Liste les "Titres likés" de l\'utilisateur (du plus récemment liké au plus ancien), paginée par limit/offset. ' +
            'Renvoie name, artist, album, uri, added_at pour chaque titre et le total.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    default: 50,
                    description: 'Nombre de titres (max 50).',
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    default: 0,
                    description: 'Index du premier titre renvoyé (pagination).',
                },
            },
        },
    },
    {
        name: 'save_albums',
        description:
            "Enregistre des albums dans la bibliothèque de l'utilisateur. uris accepte des ids, des URIs spotify:album:… ou des URLs open.spotify.com/album/….",
        inputSchema: {
            type: 'object',
            properties: {
                uris: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    description:
                        'Ids, URIs spotify:album:… ou URLs des albums à enregistrer.',
                },
            },
            required: ['uris'],
        },
    },
    {
        name: 'remove_saved_albums',
        description:
            "Retire des albums de la bibliothèque de l'utilisateur. uris accepte des ids, des URIs spotify:album:… ou des URLs open.spotify.com/album/….",
        inputSchema: {
            type: 'object',
            properties: {
                uris: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    description:
                        'Ids, URIs spotify:album:… ou URLs des albums à retirer.',
                },
            },
            required: ['uris'],
        },
    },
    {
        name: 'get_saved_albums',
        description:
            'Liste les albums enregistrés dans la bibliothèque (du plus récent au plus ancien), paginée par limit/offset. ' +
            'Renvoie name, artist, uri, total_tracks, added_at pour chaque album et le total.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    default: 50,
                    description: "Nombre d'albums (max 50).",
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    default: 0,
                    description: 'Index du premier album renvoyé (pagination).',
                },
            },
        },
    },
    {
        name: 'follow_artists',
        description:
            "Suit des artistes. uris accepte des ids, des URIs spotify:artist:… ou des URLs open.spotify.com/artist/… ; names sont des noms d'artistes résolus par recherche au premier résultat (la résolution est renvoyée pour vérification).",
        inputSchema: {
            type: 'object',
            properties: {
                uris: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Ids, URIs spotify:artist:… ou URLs des artistes.',
                },
                names: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Noms d\'artistes, ex. ["Daft Punk", "Justice"].',
                },
            },
        },
    },
    {
        name: 'unfollow_artists',
        description:
            'Arrête de suivre des artistes. uris accepte des ids, des URIs spotify:artist:… ou des URLs ; names sont des noms résolus par recherche au premier résultat (la résolution est renvoyée pour vérification).',
        inputSchema: {
            type: 'object',
            properties: {
                uris: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Ids, URIs spotify:artist:… ou URLs des artistes.',
                },
                names: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "Noms d'artistes à ne plus suivre.",
                },
            },
        },
    },
    {
        name: 'get_followed_artists',
        description:
            "Liste les artistes suivis par l'utilisateur. Renvoie name, uri, genres (3 premiers), followers pour chacun et le total.",
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    default: 50,
                    description: "Nombre d'artistes (max 50).",
                },
            },
        },
    },
    {
        name: 'follow_playlist',
        description:
            'Suit (ajoute à la bibliothèque) une playlist désignée par son id, son URI spotify:playlist:… ou son URL open.spotify.com/playlist/…. ' +
            "N'accepte PAS un nom : pour retrouver une playlist par nom, utiliser les outils de recherche de playlists.",
        inputSchema: {
            type: 'object',
            properties: {
                playlist: {
                    type: 'string',
                    description:
                        'Id, URI spotify:playlist:… ou URL open.spotify.com/playlist/… de la playlist.',
                },
                public: {
                    type: 'boolean',
                    default: true,
                    description:
                        'true (défaut) : la playlist apparaît publiquement dans le profil ; false : suivie en privé.',
                },
            },
            required: ['playlist'],
        },
    },
    {
        name: 'get_recently_played',
        description:
            "Historique d'écoute : les derniers titres joués, du plus récent au plus ancien. Renvoie played_at (ISO), name, artist, album, uri et le context (uri/type : playlist, album, artist) si l'écoute venait d'un contexte.",
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    default: 20,
                    description: 'Nombre de titres (max 50).',
                },
            },
        },
    },
    {
        name: 'get_top_tracks',
        description:
            "Titres les plus écoutés par l'utilisateur sur une période, classés par affinité (rank 1 = le plus écouté). " +
            TIME_RANGE_DESC +
            ' Renvoie rank, name, artist, album, uri, popularity (0-100, popularité mondiale du titre).',
        inputSchema: {
            type: 'object',
            properties: {
                timeRange: {
                    type: 'string',
                    enum: ['short_term', 'medium_term', 'long_term'],
                    default: 'medium_term',
                    description: TIME_RANGE_DESC,
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    default: 20,
                    description: 'Nombre de titres (max 50).',
                },
            },
        },
    },
    {
        name: 'get_top_artists',
        description:
            "Artistes les plus écoutés par l'utilisateur sur une période, classés par affinité (rank 1 = le plus écouté). " +
            TIME_RANGE_DESC +
            ' Renvoie rank, name, uri, genres, popularity (0-100).',
        inputSchema: {
            type: 'object',
            properties: {
                timeRange: {
                    type: 'string',
                    enum: ['short_term', 'medium_term', 'long_term'],
                    default: 'medium_term',
                    description: TIME_RANGE_DESC,
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    default: 20,
                    description: "Nombre d'artistes (max 50).",
                },
            },
        },
    },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type TimeRange = 'short_term' | 'medium_term' | 'long_term';
const TIME_RANGES: readonly TimeRange[] = [
    'short_term',
    'medium_term',
    'long_term',
];

function timeRange(value: unknown): TimeRange {
    return TIME_RANGES.includes(value as TimeRange)
        ? (value as TimeRange)
        : 'medium_term';
}

/** Wrap a handler so any thrown Spotify error becomes a clean `fail`. */
function guarded(name: string, fn: ToolHandler): ToolHandler {
    return async (args, ctx) => {
        try {
            return await fn(args, ctx);
        } catch (err) {
            const msg = describeError(err);
            Logger.error(`${name}: ${msg}`);
            return fail(`${name} : ${msg}`);
        }
    };
}

const handlers: Record<string, ToolHandler> = {
    save_tracks: guarded('save_tracks', async (args, { api }: ToolContext) => {
        const r = await collectTrackIds(api, args);
        if ('error' in r) return fail(r.error);
        for (const slice of chunk(r.ids, TRACK_CHUNK))
            await api.addToMySavedTracks(slice);
        Logger.info(`save_tracks: ${r.ids.length} titre(s) likés`);
        return text(summary('Liké', r.ids.length, r.notes));
    }),

    remove_saved_tracks: guarded(
        'remove_saved_tracks',
        async (args, { api }) => {
            const r = await collectTrackIds(api, { uris: args.uris });
            if ('error' in r) return fail(r.error);
            for (const slice of chunk(r.ids, TRACK_CHUNK))
                await api.removeFromMySavedTracks(slice);
            Logger.info(
                `remove_saved_tracks: ${r.ids.length} titre(s) retirés`,
            );
            return text(summary('Retiré des likes', r.ids.length, r.notes));
        },
    ),

    get_saved_tracks: guarded('get_saved_tracks', async (args, { api }) => {
        const limit = clampInt(args.limit, 50, 1, 50);
        const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const res = await api.getMySavedTracks({ limit, offset });
        const items = res.body.items.map((it) => ({
            ...formatTrack(it.track),
            added_at: it.added_at,
        }));
        return json({
            total: res.body.total,
            offset,
            count: items.length,
            items,
        });
    }),

    save_albums: guarded('save_albums', async (args, { api }) => {
        const r = parseAlbumIds(args);
        if ('error' in r) return fail(r.error);
        for (const slice of chunk(r.ids, ALBUM_CHUNK))
            await api.addToMySavedAlbums(slice);
        return text(summary('Enregistré', r.ids.length, []));
    }),

    remove_saved_albums: guarded(
        'remove_saved_albums',
        async (args, { api }) => {
            const r = parseAlbumIds(args);
            if ('error' in r) return fail(r.error);
            for (const slice of chunk(r.ids, ALBUM_CHUNK))
                await api.removeFromMySavedAlbums(slice);
            return text(summary('Retiré de la bibliothèque', r.ids.length, []));
        },
    ),

    get_saved_albums: guarded('get_saved_albums', async (args, { api }) => {
        const limit = clampInt(args.limit, 50, 1, 50);
        const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const res = await api.getMySavedAlbums({ limit, offset });
        const items = res.body.items.map((it) => ({
            name: it.album.name,
            artist: artistNames(it.album.artists),
            uri: it.album.uri,
            total_tracks:
                it.album.total_tracks ?? it.album.tracks?.total ?? null,
            added_at: it.added_at,
        }));
        return json({
            total: res.body.total,
            offset,
            count: items.length,
            items,
        });
    }),

    follow_artists: guarded('follow_artists', async (args, { api }) => {
        const r = await collectArtistIds(api, args);
        if ('error' in r) return fail(r.error);
        for (const slice of chunk(r.ids, ARTIST_CHUNK))
            await api.followArtists(slice);
        return text(summary('Suivi', r.ids.length, r.notes));
    }),

    unfollow_artists: guarded('unfollow_artists', async (args, { api }) => {
        const r = await collectArtistIds(api, args);
        if ('error' in r) return fail(r.error);
        for (const slice of chunk(r.ids, ARTIST_CHUNK))
            await api.unfollowArtists(slice);
        return text(summary('Plus suivi', r.ids.length, r.notes));
    }),

    get_followed_artists: guarded(
        'get_followed_artists',
        async (args, { api }) => {
            const limit = clampInt(args.limit, 50, 1, 50);
            const res = await api.getFollowedArtists({ limit });
            const page = res.body.artists;
            const items = page.items.map((a) => ({
                name: a.name,
                uri: a.uri,
                genres: (a.genres ?? []).slice(0, 3),
                followers: a.followers?.total ?? null,
            }));
            return json({ total: page.total, count: items.length, items });
        },
    ),

    follow_playlist: guarded('follow_playlist', async (args, { api }) => {
        let id: string;
        try {
            id = toId('playlist', args.playlist);
        } catch (err) {
            return fail((err as Error).message);
        }
        const isPublic =
            args.public === undefined ? true : Boolean(args.public);
        await api.followPlaylist(id, { public: isPublic });
        return text(
            `Playlist ${toUri('playlist', id)} suivie${
                isPublic ? '' : ' (en privé)'
            }.`,
        );
    }),

    get_recently_played: guarded(
        'get_recently_played',
        async (args, { api }) => {
            const limit = clampInt(args.limit, 20, 1, 50);
            const res = await api.getMyRecentlyPlayedTracks({ limit });
            const items = res.body.items.map((it) => ({
                played_at: it.played_at,
                ...formatTrack(it.track),
                context: it.context
                    ? { uri: it.context.uri, type: it.context.type }
                    : null,
            }));
            return json({ count: items.length, items });
        },
    ),

    get_top_tracks: guarded('get_top_tracks', async (args, { api }) => {
        const limit = clampInt(args.limit, 20, 1, 50);
        const time_range = timeRange(args.timeRange);
        const res = await api.getMyTopTracks({ time_range, limit });
        const items = res.body.items.map((t, i) => ({
            rank: i + 1,
            ...formatTrack(t),
            popularity: t.popularity,
        }));
        return json({ time_range, count: items.length, items });
    }),

    get_top_artists: guarded('get_top_artists', async (args, { api }) => {
        const limit = clampInt(args.limit, 20, 1, 50);
        const time_range = timeRange(args.timeRange);
        const res = await api.getMyTopArtists({ time_range, limit });
        const items = res.body.items.map((a, i) => ({
            rank: i + 1,
            name: a.name,
            uri: a.uri,
            genres: a.genres ?? [],
            popularity: a.popularity,
        }));
        return json({ time_range, count: items.length, items });
    }),
};

export const library: ToolModule = { tools, handlers };
