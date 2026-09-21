import type SpotifyWebApi from 'spotify-web-api-node';
import Logger from './logger';

export interface PlaylistLike {
    id: string;
    name: string;
}

export type PlaylistRef =
    | { kind: 'id'; id: string }
    | { kind: 'name'; name: string };

const ID_RE = /^[0-9A-Za-z]{22}$/;
const URI_RE = /^spotify:(?:user:[^:]+:)?playlist:([0-9A-Za-z]{22})$/;
const URL_RE =
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:user\/[^/]+\/)?playlist\/([0-9A-Za-z]{22})(?:[/?#].*)?$/i;

/**
 * Classify a `playlist` argument: raw 22-char base62 id, `spotify:playlist:<id>`
 * URI, `https://open.spotify.com/playlist/<id>` URL — anything else is a name.
 */
export function parsePlaylistRef(ref: string): PlaylistRef {
    const s = ref.trim();
    if (ID_RE.test(s)) return { kind: 'id', id: s };
    const uri = URI_RE.exec(s);
    if (uri) return { kind: 'id', id: uri[1] };
    const url = URL_RE.exec(s);
    if (url) return { kind: 'id', id: url[1] };
    return { kind: 'name', name: s };
}

export type NameMatch<T> =
    | { ok: true; playlist: T }
    | { ok: false; error: string };

/**
 * Case-insensitive exact match first, then a unique partial (`includes`)
 * match. Several partial matches → error listing them; none → error with the
 * count of playlists searched.
 */
export function matchPlaylistByName<T extends PlaylistLike>(
    playlists: T[],
    name: string,
): NameMatch<T> {
    const lower = name.trim().toLowerCase();
    const exact = playlists.filter((p) => p.name.toLowerCase() === lower);
    if (exact.length >= 1) return { ok: true, playlist: exact[0] };

    const partial = playlists.filter((p) =>
        p.name.toLowerCase().includes(lower),
    );
    if (partial.length === 1) return { ok: true, playlist: partial[0] };
    if (partial.length > 1) {
        const names = partial.map((p) => `"${p.name}" (${p.id})`).join(', ');
        return {
            ok: false,
            error: `Several playlists match "${name}": ${names}. Use the exact name or the id.`,
        };
    }
    return {
        ok: false,
        error: `No playlist named "${name}" among your ${playlists.length} playlists.`,
    };
}

export const PLAYLIST_PAGE_SIZE = 50;
export const PLAYLIST_FETCH_CAP = 500;

/** All of the current user's playlists (owned + followed), paginated, capped. */
export async function fetchAllUserPlaylists(
    api: Pick<SpotifyWebApi, 'getUserPlaylists'>,
): Promise<SpotifyApi.PlaylistObjectSimplified[]> {
    const all: SpotifyApi.PlaylistObjectSimplified[] = [];
    let offset = 0;
    for (;;) {
        const res = await api.getUserPlaylists({
            limit: PLAYLIST_PAGE_SIZE,
            offset,
        });
        const items = res.body.items ?? [];
        all.push(...items);
        offset += items.length;
        const done =
            items.length < PLAYLIST_PAGE_SIZE ||
            !res.body.next ||
            offset >= res.body.total;
        if (done || offset >= PLAYLIST_FETCH_CAP) {
            if (!done)
                Logger.warn(
                    `resolvePlaylist: stopped paginating at ${offset} playlists (cap)`,
                );
            break;
        }
    }
    return all;
}

export type Resolved =
    | { ok: true; id: string; name?: string }
    | { ok: false; error: string };

/** Resolve a `playlist` argument to a Spotify playlist id (network only for names). */
export async function resolvePlaylistId(
    api: Pick<SpotifyWebApi, 'getUserPlaylists'>,
    ref: string,
): Promise<Resolved> {
    const parsed = parsePlaylistRef(ref);
    if (parsed.kind === 'id') return { ok: true, id: parsed.id };
    if (!parsed.name)
        return {
            ok: false,
            error: 'playlist is required (id, URI, URL or name).',
        };
    const playlists = await fetchAllUserPlaylists(api);
    const match = matchPlaylistByName(playlists, parsed.name);
    if (!match.ok) return match;
    Logger.debug(
        `resolvePlaylist: "${parsed.name}" → ${match.playlist.id} (${match.playlist.name})`,
    );
    return { ok: true, id: match.playlist.id, name: match.playlist.name };
}
