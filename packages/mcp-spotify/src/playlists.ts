import type SpotifyWebApi from 'spotify-web-api-node';
import {
    describeError,
    fail,
    json,
    type ToolDefinition,
    type ToolHandler,
    type ToolModule,
} from './types';
import { resolvePlaylistId } from './resolvePlaylist';
import Logger from './logger';

/** Spotify caps add/remove/replace at 100 URIs per request. */
export const URI_CHUNK = 100;
const TRACKS_MAX_LIMIT = 100;
const TRACKS_DEFAULT_LIMIT = 50;

const PLAYLIST_ARG = {
    type: 'string',
    description:
        "Playlist reference: a Spotify id (22 chars), a spotify:playlist:<id> URI, an https://open.spotify.com/playlist/<id> URL, or the playlist name (case-insensitive; exact name preferred, else a unique partial match among the user's playlists).",
};

const URIS_ARG = {
    type: 'array',
    items: { type: 'string' },
    description:
        'Track URIs, e.g. "spotify:track:4iV5W9uYEdYUVa79Axb7Rh" (bare 22-char track ids are accepted too).',
};

export function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

const TRACK_ID_RE = /^[0-9A-Za-z]{22}$/;

/** Normalise a bare track id or open.spotify.com track URL to a track URI. */
export function normalizeTrackUri(u: string): string {
    const s = u.trim();
    if (TRACK_ID_RE.test(s)) return `spotify:track:${s}`;
    const m =
        /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([0-9A-Za-z]{22})/i.exec(
            s,
        );
    if (m) return `spotify:track:${m[1]}`;
    return s;
}

function stringArray(v: unknown, field: string): string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new Error(`${field} must be an array of strings`);
    }
    return v as string[];
}

function intArg(v: unknown, field: string, def?: number): number {
    if (v === undefined || v === null) {
        if (def === undefined) throw new Error(`${field} is required`);
        return def;
    }
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 0)
        throw new Error(`${field} must be a non-negative integer`);
    return n;
}

function playlistUrl(id: string): string {
    return `https://open.spotify.com/playlist/${id}`;
}

async function resolveOrFail(
    api: SpotifyWebApi,
    args: Record<string, unknown>,
) {
    const ref = typeof args.playlist === 'string' ? args.playlist : '';
    if (!ref.trim())
        return {
            ok: false as const,
            error: 'playlist is required (id, URI, URL or name).',
        };
    return resolvePlaylistId(api, ref);
}

/** Wrap a handler: arg errors → fail(), Spotify errors → describeError. */
function guarded(name: string, fn: ToolHandler): ToolHandler {
    return async (args, ctx) => {
        try {
            return await fn(args, ctx);
        } catch (err) {
            const msg = describeError(err);
            Logger.error(`${name}: ${msg}`);
            return fail(`${name}: ${msg}`);
        }
    };
}

// ─── tool definitions ────────────────────────────────────────────────────────

const tools: ToolDefinition[] = [
    {
        name: 'create_playlist',
        description:
            'Create a new playlist for the current Spotify user (empty; add tracks with add_tracks_to_playlist). Returns id, uri, name and url. Private by default.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Playlist name.' },
                description: {
                    type: 'string',
                    description:
                        'Optional playlist description shown in Spotify.',
                },
                public: {
                    type: 'boolean',
                    description:
                        'Make the playlist public. Default false (private).',
                },
            },
            required: ['name'],
        },
    },
    {
        name: 'update_playlist_details',
        description:
            'Change the name, description and/or public flag of a playlist the user owns. Only the provided fields are changed.',
        inputSchema: {
            type: 'object',
            properties: {
                playlist: PLAYLIST_ARG,
                name: { type: 'string', description: 'New name.' },
                description: {
                    type: 'string',
                    description: 'New description.',
                },
                public: {
                    type: 'boolean',
                    description: 'true = public, false = private.',
                },
            },
            required: ['playlist'],
        },
    },
    {
        name: 'get_playlist_tracks',
        description:
            'List the tracks of a playlist, paginated. Each item has position (0-based, use it for reorder_playlist_tracks), name, artist, album, uri, duration_ms, added_at. Returns total for paging with offset.',
        inputSchema: {
            type: 'object',
            properties: {
                playlist: PLAYLIST_ARG,
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: TRACKS_MAX_LIMIT,
                    description: `Items per page, default ${TRACKS_DEFAULT_LIMIT}, max ${TRACKS_MAX_LIMIT}.`,
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    description:
                        'Index of the first item to return, default 0.',
                },
            },
            required: ['playlist'],
        },
    },
    {
        name: 'add_tracks_to_playlist',
        description:
            'Add tracks to a playlist. Give track URIs in `uris` and/or free-text searches in `queries` (e.g. "Daft Punk Around the World") — each query is resolved to its top Spotify search result. Either or both may be provided; the response reports what each query resolved to and which failed. Appends at the end unless `position` is given.',
        inputSchema: {
            type: 'object',
            properties: {
                playlist: PLAYLIST_ARG,
                uris: URIS_ARG,
                queries: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Search queries ("artist title"), each resolved to the first matching track.',
                },
                position: {
                    type: 'integer',
                    minimum: 0,
                    description:
                        'Insert at this 0-based index instead of appending.',
                },
            },
            required: ['playlist'],
        },
    },
    {
        name: 'remove_tracks_from_playlist',
        description:
            'Remove every occurrence of the given track URIs from a playlist. Get URIs from get_playlist_tracks.',
        inputSchema: {
            type: 'object',
            properties: {
                playlist: PLAYLIST_ARG,
                uris: URIS_ARG,
            },
            required: ['playlist', 'uris'],
        },
    },
    {
        name: 'replace_playlist_tracks',
        description:
            'Replace the entire contents of a playlist with the given track URIs, in order. An empty `uris` array clears the playlist. Use add_tracks_to_playlist to append without wiping.',
        inputSchema: {
            type: 'object',
            properties: {
                playlist: PLAYLIST_ARG,
                uris: {
                    ...URIS_ARG,
                    description:
                        'New complete track list (URIs). Empty array = clear the playlist.',
                },
            },
            required: ['playlist', 'uris'],
        },
    },
    {
        name: 'reorder_playlist_tracks',
        description:
            'Move a block of tracks inside a playlist. rangeStart is the 0-based position of the first track to move, rangeLength how many consecutive tracks (default 1), insertBefore the 0-based position they are inserted before (computed on the list BEFORE the move — e.g. to move track 0 to the end of a 10-track playlist use insertBefore=10; to move track 9 to the top use insertBefore=0).',
        inputSchema: {
            type: 'object',
            properties: {
                playlist: PLAYLIST_ARG,
                rangeStart: {
                    type: 'integer',
                    minimum: 0,
                    description: '0-based position of the first track to move.',
                },
                insertBefore: {
                    type: 'integer',
                    minimum: 0,
                    description: '0-based position to insert the block before.',
                },
                rangeLength: {
                    type: 'integer',
                    minimum: 1,
                    description:
                        'Number of consecutive tracks to move. Default 1.',
                },
            },
            required: ['playlist', 'rangeStart', 'insertBefore'],
        },
    },
    {
        name: 'delete_playlist',
        description:
            'Delete a playlist: unfollows it, which removes it from your library; for playlists you own this is the only deletion Spotify offers (the playlist stops appearing anywhere for you). Irreversible from the API — confirm with the user before calling.',
        inputSchema: {
            type: 'object',
            properties: {
                playlist: PLAYLIST_ARG,
            },
            required: ['playlist'],
        },
    },
];

// ─── handlers ────────────────────────────────────────────────────────────────

const createPlaylist: ToolHandler = async (args, { api }) => {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return fail('create_playlist: name is required.');
    const opts: { description?: string; public?: boolean } = {
        public: args.public === true,
    };
    if (typeof args.description === 'string')
        opts.description = args.description;
    const res = await api.createPlaylist(name, opts);
    const p = res.body;
    Logger.info(`create_playlist: "${p.name}" → ${p.id}`);
    return json({
        id: p.id,
        uri: p.uri ?? `spotify:playlist:${p.id}`,
        name: p.name,
        url: p.external_urls?.spotify ?? playlistUrl(p.id),
        public: p.public,
        description: p.description ?? '',
    });
};

const updatePlaylistDetails: ToolHandler = async (args, { api }) => {
    const r = await resolveOrFail(api, args);
    if (!r.ok) return fail(r.error);
    const opts: { name?: string; description?: string; public?: boolean } = {};
    if (typeof args.name === 'string' && args.name.trim())
        opts.name = args.name.trim();
    if (typeof args.description === 'string')
        opts.description = args.description;
    if (typeof args.public === 'boolean') opts.public = args.public;
    if (Object.keys(opts).length === 0) {
        return fail(
            'update_playlist_details: nothing to change (give name, description and/or public).',
        );
    }
    await api.changePlaylistDetails(r.id, opts);
    Logger.info(`update_playlist_details: ${r.id} ${JSON.stringify(opts)}`);
    return json({ id: r.id, url: playlistUrl(r.id), updated: opts });
};

const getPlaylistTracks: ToolHandler = async (args, { api }) => {
    const r = await resolveOrFail(api, args);
    if (!r.ok) return fail(r.error);
    const limit = Math.min(
        Math.max(intArg(args.limit, 'limit', TRACKS_DEFAULT_LIMIT), 1),
        TRACKS_MAX_LIMIT,
    );
    const offset = intArg(args.offset, 'offset', 0);
    const res = await api.getPlaylistTracks(r.id, { limit, offset });
    const page = res.body;
    const items = (page.items ?? []).map((it, i) => {
        // `item` supersedes `track` (deprecated Feb 2026 for dev-mode apps).
        const t =
            (it as { item?: SpotifyApi.TrackObjectFull | null }).item ??
            it.track;
        return {
            position: offset + i,
            name: t?.name ?? '(unavailable)',
            artist: t?.artists?.map((a) => a.name).join(', ') ?? '',
            album: t?.album?.name ?? '',
            uri: t?.uri ?? '',
            duration_ms: t?.duration_ms ?? 0,
            added_at: it.added_at,
        };
    });
    return json({
        playlist: { id: r.id, name: r.name, url: playlistUrl(r.id) },
        total: page.total,
        offset,
        limit,
        items,
    });
};

type QueryResult = {
    query: string;
    uri?: string;
    name?: string;
    artist?: string;
    error?: string;
};

async function resolveQueries(
    api: SpotifyWebApi,
    queries: string[],
): Promise<QueryResult[]> {
    const out: QueryResult[] = [];
    for (const query of queries) {
        const q = query.trim();
        if (!q) {
            out.push({ query, error: 'empty query' });
            continue;
        }
        try {
            const res = await api.search(q, ['track'], { limit: 1 });
            const t = res.body.tracks?.items?.[0];
            if (!t) out.push({ query, error: 'no track found' });
            else
                out.push({
                    query,
                    uri: t.uri,
                    name: t.name,
                    artist: t.artists?.map((a) => a.name).join(', '),
                });
        } catch (err) {
            out.push({ query, error: describeError(err) });
        }
    }
    return out;
}

const addTracksToPlaylist: ToolHandler = async (args, { api }) => {
    const r = await resolveOrFail(api, args);
    if (!r.ok) return fail(r.error);
    const uris = stringArray(args.uris, 'uris')
        .map(normalizeTrackUri)
        .filter(Boolean);
    const queries = stringArray(args.queries, 'queries');
    if (uris.length === 0 && queries.length === 0) {
        return fail(
            'add_tracks_to_playlist: give at least one of uris or queries.',
        );
    }
    const resolved = await resolveQueries(api, queries);
    const all = [...uris, ...resolved.flatMap((q) => (q.uri ? [q.uri] : []))];
    const failed = resolved.filter((q) => q.error);
    if (all.length === 0) {
        return fail(
            `add_tracks_to_playlist: none of the queries resolved to a track: ${failed
                .map((q) => `"${q.query}" (${q.error})`)
                .join(', ')}`,
        );
    }

    const position =
        args.position === undefined || args.position === null
            ? undefined
            : intArg(args.position, 'position');
    let snapshot: string | undefined;
    let cursor = position;
    for (const batch of chunk(all, URI_CHUNK)) {
        const res = await api.addTracksToPlaylist(
            r.id,
            batch,
            cursor === undefined ? {} : { position: cursor },
        );
        snapshot = res.body.snapshot_id;
        if (cursor !== undefined) cursor += batch.length; // keep later chunks in order after the first
    }
    Logger.info(`add_tracks_to_playlist: ${all.length} track(s) → ${r.id}`);
    return json({
        playlist: { id: r.id, name: r.name, url: playlistUrl(r.id) },
        added: all.length,
        position: position ?? 'end',
        snapshot_id: snapshot,
        resolvedQueries: resolved.filter((q) => q.uri),
        failedQueries: failed,
    });
};

const removeTracksFromPlaylist: ToolHandler = async (args, { api }) => {
    const r = await resolveOrFail(api, args);
    if (!r.ok) return fail(r.error);
    const uris = stringArray(args.uris, 'uris')
        .map(normalizeTrackUri)
        .filter(Boolean);
    if (uris.length === 0)
        return fail(
            'remove_tracks_from_playlist: uris must contain at least one track URI.',
        );
    let snapshot: string | undefined;
    for (const batch of chunk(uris, URI_CHUNK)) {
        const res = await api.removeTracksFromPlaylist(
            r.id,
            batch.map((uri) => ({ uri })),
        );
        snapshot = res.body.snapshot_id;
    }
    Logger.info(
        `remove_tracks_from_playlist: ${uris.length} uri(s) from ${r.id}`,
    );
    return json({
        playlist: { id: r.id, name: r.name },
        removed: uris.length,
        snapshot_id: snapshot,
    });
};

const replacePlaylistTracks: ToolHandler = async (args, { api }) => {
    const r = await resolveOrFail(api, args);
    if (!r.ok) return fail(r.error);
    if (!Array.isArray(args.uris))
        return fail(
            'replace_playlist_tracks: uris is required (empty array clears the playlist).',
        );
    const uris = stringArray(args.uris, 'uris')
        .map(normalizeTrackUri)
        .filter(Boolean);
    const [first = [], ...rest] = chunk(uris, URI_CHUNK);
    await api.replaceTracksInPlaylist(r.id, first);
    let snapshot: string | undefined;
    for (const batch of rest) {
        const res = await api.addTracksToPlaylist(r.id, batch);
        snapshot = res.body.snapshot_id;
    }
    Logger.info(
        `replace_playlist_tracks: ${r.id} now has ${uris.length} track(s)`,
    );
    return json({
        playlist: { id: r.id, name: r.name },
        tracks: uris.length,
        cleared: uris.length === 0,
        snapshot_id: snapshot,
    });
};

const reorderPlaylistTracks: ToolHandler = async (args, { api }) => {
    const r = await resolveOrFail(api, args);
    if (!r.ok) return fail(r.error);
    const rangeStart = intArg(args.rangeStart, 'rangeStart');
    const insertBefore = intArg(args.insertBefore, 'insertBefore');
    const rangeLength = intArg(args.rangeLength, 'rangeLength', 1);
    if (rangeLength < 1)
        return fail('reorder_playlist_tracks: rangeLength must be ≥ 1.');
    const res = await api.reorderTracksInPlaylist(
        r.id,
        rangeStart,
        insertBefore,
        { range_length: rangeLength },
    );
    Logger.info(
        `reorder_playlist_tracks: ${r.id} [${rangeStart}+${rangeLength}] → before ${insertBefore}`,
    );
    return json({
        playlist: { id: r.id, name: r.name },
        rangeStart,
        rangeLength,
        insertBefore,
        snapshot_id: res.body.snapshot_id,
    });
};

const deletePlaylist: ToolHandler = async (args, { api }) => {
    const r = await resolveOrFail(api, args);
    if (!r.ok) return fail(r.error);
    await api.unfollowPlaylist(r.id);
    Logger.info(`delete_playlist: unfollowed ${r.id}`);
    return json({
        id: r.id,
        name: r.name,
        deleted: true,
        note: 'Playlist unfollowed (removed from your library). Spotify has no hard delete; if you owned it, it is gone from your account.',
    });
};

const handlers: Record<string, ToolHandler> = {
    create_playlist: guarded('create_playlist', createPlaylist),
    update_playlist_details: guarded(
        'update_playlist_details',
        updatePlaylistDetails,
    ),
    get_playlist_tracks: guarded('get_playlist_tracks', getPlaylistTracks),
    add_tracks_to_playlist: guarded(
        'add_tracks_to_playlist',
        addTracksToPlaylist,
    ),
    remove_tracks_from_playlist: guarded(
        'remove_tracks_from_playlist',
        removeTracksFromPlaylist,
    ),
    replace_playlist_tracks: guarded(
        'replace_playlist_tracks',
        replacePlaylistTracks,
    ),
    reorder_playlist_tracks: guarded(
        'reorder_playlist_tracks',
        reorderPlaylistTracks,
    ),
    delete_playlist: guarded('delete_playlist', deletePlaylist),
};

export const playlists: ToolModule = { tools, handlers };
