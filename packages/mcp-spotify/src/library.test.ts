import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, clampInt, library, toId } from './library';
import type { ToolContext } from './types';

const ID = '4iV5W9uYEdYUVa79Axb7Rh';
const ID2 = '0LcJLqbBmaGUft1e9Mm8HV';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('toId: bare ids, URIs and open.spotify.com URLs for each kind', () => {
    for (const kind of ['track', 'album', 'artist', 'playlist'] as const) {
        assert.equal(toId(kind, ID), ID, `${kind} bare id`);
        assert.equal(toId(kind, `spotify:${kind}:${ID}`), ID, `${kind} uri`);
        assert.equal(
            toId(kind, `https://open.spotify.com/${kind}/${ID}?si=abc123`),
            ID,
            `${kind} url`,
        );
        assert.equal(
            toId(kind, `https://open.spotify.com/intl-fr/${kind}/${ID}`),
            ID,
            `${kind} intl url`,
        );
        assert.equal(
            toId(kind, `open.spotify.com/${kind}/${ID}`),
            ID,
            `${kind} bare url`,
        );
        assert.equal(
            toId(kind, `  spotify:${kind}:${ID}  `),
            ID,
            `${kind} trimmed`,
        );
    }
});

test('toId: rejects wrong kind and garbage', () => {
    assert.throws(
        () => toId('track', `spotify:playlist:${ID}`),
        /playlist, pas un track/,
    );
    assert.throws(
        () => toId('album', `https://open.spotify.com/track/${ID}`),
        /track, pas un album/,
    );
    assert.throws(
        () => toId('artist', 'Daft Punk'),
        /Référence artist invalide/,
    );
    assert.throws(() => toId('track', 42), /invalide/);
});

test('chunk splits in consecutive slices', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 50), []);
    assert.deepEqual(chunk([1, 2], 50), [[1, 2]]);
    assert.throws(() => chunk([1], 0));
});

test('clampInt clamps and falls back', () => {
    assert.equal(clampInt(undefined, 20, 1, 50), 20);
    assert.equal(clampInt('abc', 20, 1, 50), 20);
    assert.equal(clampInt(999, 20, 1, 50), 50);
    assert.equal(clampInt(0, 20, 1, 50), 1);
    assert.equal(clampInt('7', 20, 1, 50), 7);
    assert.equal(clampInt(7.9, 20, 1, 50), 7);
});

// ---------------------------------------------------------------------------
// Fake API
// ---------------------------------------------------------------------------

interface Call {
    method: string;
    args: unknown[];
}

function fakeApi(overrides: Record<string, (...a: any[]) => unknown> = {}) {
    const calls: Call[] = [];
    const ok = (body: unknown) =>
        Promise.resolve({ body, headers: {}, statusCode: 200 });
    const defaults: Record<string, (...a: any[]) => unknown> = {
        getMyCurrentPlayingTrack: () =>
            ok({
                currently_playing_type: 'track',
                is_playing: true,
                item: {
                    id: ID,
                    name: 'Song',
                    artists: [{ name: 'Artist' }],
                    uri: `spotify:track:${ID}`,
                },
            }),
        addToMySavedTracks: () => ok({}),
        removeFromMySavedTracks: () => ok({}),
        addToMySavedAlbums: () => ok({}),
        removeFromMySavedAlbums: () => ok({}),
        followArtists: () => ok(undefined),
        unfollowArtists: () => ok(undefined),
        followPlaylist: () => ok({}),
        search: (q: string, types: string[]) =>
            ok(
                types[0] === 'artist'
                    ? {
                          artists: {
                              items: [{ id: ID2, name: `Resolved ${q}` }],
                          },
                      }
                    : {
                          tracks: {
                              items: [
                                  {
                                      id: ID2,
                                      name: `Track ${q}`,
                                      artists: [{ name: 'A' }],
                                  },
                              ],
                          },
                      },
            ),
        getMySavedTracks: () =>
            ok({
                total: 1,
                items: [
                    {
                        added_at: '2026-01-01T00:00:00Z',
                        track: {
                            name: 'T',
                            artists: [{ name: 'A' }],
                            album: { name: 'Al' },
                            uri: `spotify:track:${ID}`,
                        },
                    },
                ],
            }),
        getMySavedAlbums: () =>
            ok({
                total: 1,
                items: [
                    {
                        added_at: '2026-01-01T00:00:00Z',
                        album: {
                            name: 'Al',
                            artists: [{ name: 'A' }],
                            uri: `spotify:album:${ID}`,
                            total_tracks: 12,
                        },
                    },
                ],
            }),
        getFollowedArtists: () =>
            ok({
                artists: {
                    total: 1,
                    items: [
                        {
                            name: 'A',
                            uri: `spotify:artist:${ID}`,
                            genres: ['a', 'b', 'c', 'd'],
                            followers: { total: 10 },
                        },
                    ],
                },
            }),
        getMyRecentlyPlayedTracks: () =>
            ok({
                items: [
                    {
                        played_at: '2026-01-01T00:00:00Z',
                        context: {
                            uri: `spotify:playlist:${ID}`,
                            type: 'playlist',
                        },
                        track: {
                            name: 'T',
                            artists: [{ name: 'A' }],
                            album: { name: 'Al' },
                            uri: `spotify:track:${ID}`,
                        },
                    },
                ],
            }),
        getMyTopTracks: () =>
            ok({
                items: [
                    {
                        name: 'T',
                        artists: [{ name: 'A' }],
                        album: { name: 'Al' },
                        uri: `spotify:track:${ID}`,
                        popularity: 80,
                    },
                ],
            }),
        getMyTopArtists: () =>
            ok({
                items: [
                    {
                        name: 'A',
                        uri: `spotify:artist:${ID}`,
                        genres: ['g'],
                        popularity: 70,
                    },
                ],
            }),
    };
    const impl = { ...defaults, ...overrides };
    const api = new Proxy({} as Record<string, unknown>, {
        get(_t, prop: string) {
            const fn = impl[prop];
            if (!fn) throw new Error(`fake api: unexpected call to ${prop}`);
            return (...args: unknown[]) => {
                calls.push({ method: prop, args });
                return fn(...args);
            };
        },
    });
    const ctx = { api, defaultSpeaker: 'WiiM' } as unknown as ToolContext;
    return {
        ctx,
        calls,
        of: (m: string) => calls.filter((c) => c.method === m),
    };
}

const h = library.handlers;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

test('save_tracks without args likes the current track', async () => {
    const { ctx, of } = fakeApi();
    const res = await h.save_tracks({}, ctx);
    assert.equal(res.isError, undefined);
    assert.deepEqual(
        of('addToMySavedTracks').map((c) => c.args[0]),
        [[ID]],
    );
    assert.match(res.content[0].text, /Song — Artist/);
});

test('save_tracks without args fails cleanly when nothing plays', async () => {
    for (const body of [
        undefined,
        { item: null, currently_playing_type: 'unknown' },
        { currently_playing_type: 'episode', item: { id: 'x' } },
    ]) {
        const { ctx, of } = fakeApi({
            getMyCurrentPlayingTrack: () =>
                Promise.resolve({ body, headers: {}, statusCode: 204 }),
        });
        const res = await h.save_tracks({}, ctx);
        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /Rien ne joue/);
        assert.equal(of('addToMySavedTracks').length, 0);
    }
});

test('remove_saved_tracks without args uses the current track', async () => {
    const { ctx, of } = fakeApi();
    const res = await h.remove_saved_tracks({}, ctx);
    assert.equal(res.isError, undefined);
    assert.deepEqual(
        of('removeFromMySavedTracks').map((c) => c.args[0]),
        [[ID]],
    );
});

test('save_tracks chunks 120 ids into 3 calls of 50/50/20 and normalises URIs', async () => {
    const ids = Array.from(
        { length: 120 },
        (_, i) => `a${String(i).padStart(21, '0')}`,
    );
    const uris = ids.map((id, i) => (i % 2 ? `spotify:track:${id}` : id));
    const { ctx, of } = fakeApi();
    const res = await h.save_tracks({ uris }, ctx);
    assert.equal(res.isError, undefined);
    const sizes = of('addToMySavedTracks').map(
        (c) => (c.args[0] as string[]).length,
    );
    assert.deepEqual(sizes, [50, 50, 20]);
    const sent = of('addToMySavedTracks').flatMap((c) => c.args[0] as string[]);
    assert.deepEqual(sent, ids);
    assert.equal(of('getMyCurrentPlayingTrack').length, 0);
});

test('save_tracks with queries resolves via search(track, limit 1)', async () => {
    const { ctx, of } = fakeApi();
    const res = await h.save_tracks(
        { queries: ['Around the World Daft Punk'] },
        ctx,
    );
    assert.equal(res.isError, undefined);
    const s = of('search');
    assert.equal(s.length, 1);
    assert.deepEqual(s[0].args, [
        'Around the World Daft Punk',
        ['track'],
        { limit: 1 },
    ]);
    assert.deepEqual(of('addToMySavedTracks')[0].args[0], [ID2]);
    assert.match(res.content[0].text, /Around the World Daft Punk.*→ Track/);
});

test('save_tracks rejects a playlist URI', async () => {
    const { ctx, of } = fakeApi();
    const res = await h.save_tracks({ uris: [`spotify:playlist:${ID}`] }, ctx);
    assert.equal(res.isError, true);
    assert.equal(of('addToMySavedTracks').length, 0);
});

test('save_albums / remove_saved_albums chunk by 20 and require uris', async () => {
    const ids = Array.from(
        { length: 25 },
        (_, i) => `b${String(i).padStart(21, '0')}`,
    );
    const { ctx, of } = fakeApi();
    await h.save_albums(
        { uris: ids.map((id) => `https://open.spotify.com/album/${id}`) },
        ctx,
    );
    assert.deepEqual(
        of('addToMySavedAlbums').map((c) => (c.args[0] as string[]).length),
        [20, 5],
    );
    await h.remove_saved_albums({ uris: [`spotify:album:${ID}`] }, ctx);
    assert.deepEqual(of('removeFromMySavedAlbums')[0].args[0], [ID]);
    const res = await h.save_albums({}, ctx);
    assert.equal(res.isError, true);
});

test('follow_artists by name resolves via search(artist) and reports', async () => {
    const { ctx, of } = fakeApi();
    const res = await h.follow_artists(
        { names: ['Justice'], uris: [`spotify:artist:${ID}`] },
        ctx,
    );
    assert.equal(res.isError, undefined);
    assert.deepEqual(of('search')[0].args, [
        'Justice',
        ['artist'],
        { limit: 1 },
    ]);
    assert.deepEqual(of('followArtists')[0].args[0], [ID, ID2]);
    assert.match(res.content[0].text, /"Justice" → Resolved Justice/);
});

test('follow_artists with an unresolvable name fails without calling followArtists', async () => {
    const { ctx, of } = fakeApi({
        search: () =>
            Promise.resolve({
                body: { artists: { items: [] } },
                headers: {},
                statusCode: 200,
            }),
    });
    const res = await h.follow_artists({ names: ['zzz'] }, ctx);
    assert.equal(res.isError, true);
    assert.equal(of('followArtists').length, 0);
});

test('unfollow_artists requires an argument', async () => {
    const { ctx } = fakeApi();
    const res = await h.unfollow_artists({}, ctx);
    assert.equal(res.isError, true);
});

test('follow_playlist accepts id/URI/URL, not a name, and passes public', async () => {
    const { ctx, of } = fakeApi();
    await h.follow_playlist(
        { playlist: `https://open.spotify.com/playlist/${ID}?si=x` },
        ctx,
    );
    assert.deepEqual(of('followPlaylist')[0].args, [ID, { public: true }]);
    await h.follow_playlist(
        { playlist: `spotify:playlist:${ID}`, public: false },
        ctx,
    );
    assert.deepEqual(of('followPlaylist')[1].args, [ID, { public: false }]);
    const res = await h.follow_playlist(
        { playlist: 'Ma playlist du soir' },
        ctx,
    );
    assert.equal(res.isError, true);
    assert.equal(of('followPlaylist').length, 2);
});

test('get_top_tracks / get_top_artists pass time_range and limit through', async () => {
    const { ctx, of } = fakeApi();
    const res = await h.get_top_tracks(
        { timeRange: 'short_term', limit: 5 },
        ctx,
    );
    assert.deepEqual(of('getMyTopTracks')[0].args[0], {
        time_range: 'short_term',
        limit: 5,
    });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.time_range, 'short_term');
    assert.deepEqual(parsed.items[0], {
        rank: 1,
        name: 'T',
        artist: 'A',
        album: 'Al',
        uri: `spotify:track:${ID}`,
        popularity: 80,
    });

    await h.get_top_artists({}, ctx);
    assert.deepEqual(of('getMyTopArtists')[0].args[0], {
        time_range: 'medium_term',
        limit: 20,
    });
    await h.get_top_artists({ timeRange: 'bogus', limit: 500 }, ctx);
    assert.deepEqual(of('getMyTopArtists')[1].args[0], {
        time_range: 'medium_term',
        limit: 50,
    });
});

test('read-only listings shape their output', async () => {
    const { ctx, of } = fakeApi();
    const saved = JSON.parse(
        (await h.get_saved_tracks({ limit: 10, offset: 20 }, ctx)).content[0]
            .text,
    );
    assert.deepEqual(of('getMySavedTracks')[0].args[0], {
        limit: 10,
        offset: 20,
    });
    assert.equal(saved.total, 1);
    assert.deepEqual(saved.items[0], {
        name: 'T',
        artist: 'A',
        album: 'Al',
        uri: `spotify:track:${ID}`,
        added_at: '2026-01-01T00:00:00Z',
    });

    const albums = JSON.parse(
        (await h.get_saved_albums({}, ctx)).content[0].text,
    );
    assert.deepEqual(albums.items[0], {
        name: 'Al',
        artist: 'A',
        uri: `spotify:album:${ID}`,
        total_tracks: 12,
        added_at: '2026-01-01T00:00:00Z',
    });

    const followed = JSON.parse(
        (await h.get_followed_artists({}, ctx)).content[0].text,
    );
    assert.deepEqual(of('getFollowedArtists')[0].args[0], { limit: 50 });
    assert.deepEqual(followed.items[0].genres, ['a', 'b', 'c']);
    assert.equal(followed.items[0].followers, 10);

    const recent = JSON.parse(
        (await h.get_recently_played({ limit: 3 }, ctx)).content[0].text,
    );
    assert.deepEqual(of('getMyRecentlyPlayedTracks')[0].args[0], { limit: 3 });
    assert.deepEqual(recent.items[0].context, {
        uri: `spotify:playlist:${ID}`,
        type: 'playlist',
    });
    assert.equal(recent.items[0].played_at, '2026-01-01T00:00:00Z');
});

test('API errors become isError results with a description', async () => {
    const { ctx } = fakeApi({
        getMySavedTracks: () =>
            Promise.reject({
                statusCode: 403,
                body: { error: { message: 'Insufficient client scope' } },
            }),
    });
    const res = await h.get_saved_tracks({}, ctx);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /403/);
});

test('every tool has a handler and a well-formed schema', () => {
    assert.equal(library.tools.length, 13);
    for (const t of library.tools) {
        assert.ok(h[t.name], `${t.name} handler`);
        assert.equal(t.inputSchema.type, 'object');
        for (const r of t.inputSchema.required ?? [])
            assert.ok(r in t.inputSchema.properties);
    }
    assert.deepEqual(
        Object.keys(h).sort(),
        library.tools.map((t) => t.name).sort(),
    );
});
