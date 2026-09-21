import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playlists, chunk, normalizeTrackUri } from './playlists';
import {
    fetchAllUserPlaylists,
    matchPlaylistByName,
    parsePlaylistRef,
    resolvePlaylistId,
} from './resolvePlaylist';
import type { ToolContext } from './types';

const ID = '37i9dQZF1DXcBWIGoYBM5M';

// ─── parsePlaylistRef ────────────────────────────────────────────────────────

test('parsePlaylistRef: raw id, URI, URL → id; anything else → name', () => {
    assert.deepEqual(parsePlaylistRef(ID), { kind: 'id', id: ID });
    assert.deepEqual(parsePlaylistRef(`spotify:playlist:${ID}`), {
        kind: 'id',
        id: ID,
    });
    assert.deepEqual(parsePlaylistRef(`spotify:user:jeremy:playlist:${ID}`), {
        kind: 'id',
        id: ID,
    });
    assert.deepEqual(
        parsePlaylistRef(`https://open.spotify.com/playlist/${ID}`),
        { kind: 'id', id: ID },
    );
    assert.deepEqual(
        parsePlaylistRef(`https://open.spotify.com/playlist/${ID}?si=abc123`),
        { kind: 'id', id: ID },
    );
    assert.deepEqual(
        parsePlaylistRef(`https://open.spotify.com/intl-fr/playlist/${ID}`),
        { kind: 'id', id: ID },
    );
    assert.deepEqual(parsePlaylistRef('  Soirée Chill '), {
        kind: 'name',
        name: 'Soirée Chill',
    });
    assert.deepEqual(parsePlaylistRef('short'), {
        kind: 'name',
        name: 'short',
    });
    // 22 chars but not base62 → name
    assert.deepEqual(parsePlaylistRef('this-is-22-chars-long!'), {
        kind: 'name',
        name: 'this-is-22-chars-long!',
    });
});

// ─── matchPlaylistByName ─────────────────────────────────────────────────────

const LISTS = [
    { id: 'a', name: 'Chill' },
    { id: 'b', name: 'Chill Vibes' },
    { id: 'c', name: 'Workout' },
    { id: 'd', name: 'Soirée Chill Deep' },
];

test('matchPlaylistByName: exact (case-insensitive) beats partial', () => {
    const r = matchPlaylistByName(LISTS, 'chill');
    assert.ok(r.ok);
    assert.equal(r.playlist.id, 'a');
});

test('matchPlaylistByName: unique partial match', () => {
    const r = matchPlaylistByName(LISTS, 'work');
    assert.ok(r.ok);
    assert.equal(r.playlist.id, 'c');
});

test('matchPlaylistByName: ambiguous partial lists candidates', () => {
    const r = matchPlaylistByName(LISTS, 'ill'); // no exact, three partial hits
    assert.ok(!r.ok);
    assert.match(r.error, /Several playlists match "ill"/);
    assert.match(r.error, /"Chill" \(a\)/);
    assert.match(r.error, /Chill Vibes/);
    assert.match(r.error, /Soirée Chill Deep/);
});

test('matchPlaylistByName: not found mentions the count', () => {
    const r = matchPlaylistByName(LISTS, 'Jazz');
    assert.ok(!r.ok);
    assert.equal(r.error, 'No playlist named "Jazz" among your 4 playlists.');
});

// ─── resolvePlaylistId / pagination ──────────────────────────────────────────

function fakeUserPlaylists(all: Array<{ id: string; name: string }>) {
    const calls: Array<{ limit?: number; offset?: number }> = [];
    const api = {
        async getUserPlaylists(opts?: { limit?: number; offset?: number }) {
            calls.push(opts ?? {});
            const offset = opts?.offset ?? 0;
            const limit = opts?.limit ?? 20;
            const items = all.slice(offset, offset + limit);
            return {
                body: {
                    items,
                    total: all.length,
                    next: offset + limit < all.length ? 'next' : null,
                },
                headers: {},
                statusCode: 200,
            } as any;
        },
    };
    return { api, calls };
}

test('fetchAllUserPlaylists paginates by 50 until done', async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({
        id: `p${i}`,
        name: `Playlist ${i}`,
    }));
    const { api, calls } = fakeUserPlaylists(all);
    const got = await fetchAllUserPlaylists(api as any);
    assert.equal(got.length, 120);
    assert.deepEqual(
        calls.map((c) => c.offset),
        [0, 50, 100],
    );
});

test('resolvePlaylistId: id needs no network, name hits the API', async () => {
    const { api, calls } = fakeUserPlaylists([{ id: 'x', name: 'Focus' }]);
    const byId = await resolvePlaylistId(api as any, `spotify:playlist:${ID}`);
    assert.deepEqual(byId, { ok: true, id: ID });
    assert.equal(calls.length, 0);
    const byName = await resolvePlaylistId(api as any, 'focus');
    assert.deepEqual(byName, { ok: true, id: 'x', name: 'Focus' });
    assert.equal(calls.length, 1);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

test('chunk and normalizeTrackUri', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 2), []);
    assert.equal(
        normalizeTrackUri('4iV5W9uYEdYUVa79Axb7Rh'),
        'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
    );
    assert.equal(
        normalizeTrackUri(
            'https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh?si=1',
        ),
        'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
    );
    assert.equal(
        normalizeTrackUri('spotify:track:4iV5W9uYEdYUVa79Axb7Rh'),
        'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
    );
});

// ─── handlers with a fake api ────────────────────────────────────────────────

function fakeApi() {
    const log: Array<{ method: string; args: unknown[] }> = [];
    const rec =
        (method: string, body: unknown = {}) =>
        async (...args: unknown[]) => {
            log.push({ method, args });
            return { body, headers: {}, statusCode: 200 };
        };
    const api = {
        getUserPlaylists: async () => ({
            body: {
                items: [{ id: 'pl1', name: 'Mes Favoris' }],
                total: 1,
                next: null,
            },
            headers: {},
            statusCode: 200,
        }),
        search: async (q: string, types: string[], opts: unknown) => {
            log.push({ method: 'search', args: [q, types, opts] });
            const hits: Record<
                string,
                { uri: string; name: string; artists: { name: string }[] }
            > = {
                'daft punk around the world': {
                    uri: 'spotify:track:AAA',
                    name: 'Around the World',
                    artists: [{ name: 'Daft Punk' }],
                },
                'justice dance': {
                    uri: 'spotify:track:BBB',
                    name: 'D.A.N.C.E.',
                    artists: [{ name: 'Justice' }],
                },
            };
            const t = hits[q.toLowerCase()];
            return {
                body: { tracks: { items: t ? [t] : [] } },
                headers: {},
                statusCode: 200,
            };
        },
        addTracksToPlaylist: rec('addTracksToPlaylist', {
            snapshot_id: 'snap',
        }),
        removeTracksFromPlaylist: rec('removeTracksFromPlaylist', {
            snapshot_id: 'snap',
        }),
        replaceTracksInPlaylist: rec('replaceTracksInPlaylist', {}),
        reorderTracksInPlaylist: rec('reorderTracksInPlaylist', {
            snapshot_id: 'snap',
        }),
        unfollowPlaylist: rec('unfollowPlaylist', {}),
        changePlaylistDetails: rec('changePlaylistDetails', {}),
        createPlaylist: async (name: string, opts: unknown) => {
            log.push({ method: 'createPlaylist', args: [name, opts] });
            return {
                body: {
                    id: 'new1',
                    name,
                    uri: 'spotify:playlist:new1',
                    public: false,
                    description: '',
                    external_urls: {
                        spotify: 'https://open.spotify.com/playlist/new1',
                    },
                },
                headers: {},
                statusCode: 200,
            };
        },
    };
    const ctx = { api: api as any, defaultSpeaker: 'WiiM' } as ToolContext;
    return { ctx, log };
}

const parse = (r: { content: Array<{ text: string }> }) =>
    JSON.parse(r.content[0].text);

test('add_tracks_to_playlist resolves queries via search and reports failures', async () => {
    const { ctx, log } = fakeApi();
    const res = await playlists.handlers.add_tracks_to_playlist(
        {
            playlist: 'mes favoris',
            queries: ['Daft Punk Around the World', 'nonexistent song zzz'],
            uris: ['spotify:track:CCC'],
        },
        ctx,
    );
    assert.ok(!res.isError, res.content[0].text);
    const out = parse(res);
    assert.equal(out.playlist.id, 'pl1');
    assert.equal(out.added, 2);
    assert.equal(out.resolvedQueries.length, 1);
    assert.equal(out.resolvedQueries[0].uri, 'spotify:track:AAA');
    assert.equal(out.failedQueries.length, 1);
    assert.equal(out.failedQueries[0].query, 'nonexistent song zzz');
    const searches = log.filter((l) => l.method === 'search');
    assert.equal(searches.length, 2);
    assert.deepEqual(searches[0].args.slice(1), [['track'], { limit: 1 }]);
    const adds = log.filter((l) => l.method === 'addTracksToPlaylist');
    assert.equal(adds.length, 1);
    assert.deepEqual(adds[0].args[1], [
        'spotify:track:CCC',
        'spotify:track:AAA',
    ]);
});

test('add_tracks_to_playlist chunks >100 uris into several calls, positions stay ordered', async () => {
    const { ctx, log } = fakeApi();
    const uris = Array.from(
        { length: 250 },
        (_, i) => `spotify:track:${String(i).padStart(22, '0')}`,
    );
    const res = await playlists.handlers.add_tracks_to_playlist(
        { playlist: 'pl1'.padEnd(22, 'x'), uris, position: 5 },
        ctx,
    );
    assert.ok(!res.isError, res.content[0].text);
    const adds = log.filter((l) => l.method === 'addTracksToPlaylist');
    assert.equal(adds.length, 3);
    assert.deepEqual(
        adds.map((a) => (a.args[1] as string[]).length),
        [100, 100, 50],
    );
    assert.deepEqual(
        adds.map((a) => (a.args[2] as { position?: number }).position),
        [5, 105, 205],
    );
    assert.equal(parse(res).added, 250);
});

test('add_tracks_to_playlist fails when nothing given or nothing resolves', async () => {
    const { ctx } = fakeApi();
    const none = await playlists.handlers.add_tracks_to_playlist(
        { playlist: 'Mes Favoris' },
        ctx,
    );
    assert.ok(none.isError);
    const bad = await playlists.handlers.add_tracks_to_playlist(
        { playlist: 'Mes Favoris', queries: ['zzz'] },
        ctx,
    );
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /none of the queries resolved/);
});

test('remove_tracks_from_playlist chunks by 100 and sends {uri} objects', async () => {
    const { ctx, log } = fakeApi();
    const uris = Array.from({ length: 101 }, (_, i) => `spotify:track:t${i}`);
    const res = await playlists.handlers.remove_tracks_from_playlist(
        { playlist: 'Mes Favoris', uris },
        ctx,
    );
    assert.ok(!res.isError);
    const rm = log.filter((l) => l.method === 'removeTracksFromPlaylist');
    assert.equal(rm.length, 2);
    assert.deepEqual((rm[0].args[1] as unknown[])[0], {
        uri: 'spotify:track:t0',
    });
    assert.equal((rm[1].args[1] as unknown[]).length, 1);
});

test('replace_playlist_tracks: empty clears, >100 replaces first 100 then adds the rest', async () => {
    const { ctx, log } = fakeApi();
    const clear = await playlists.handlers.replace_playlist_tracks(
        { playlist: 'Mes Favoris', uris: [] },
        ctx,
    );
    assert.ok(!clear.isError);
    assert.equal(parse(clear).cleared, true);
    assert.deepEqual(log.at(-1), {
        method: 'replaceTracksInPlaylist',
        args: ['pl1', []],
    });

    log.length = 0;
    const uris = Array.from({ length: 130 }, (_, i) => `spotify:track:t${i}`);
    const res = await playlists.handlers.replace_playlist_tracks(
        { playlist: 'Mes Favoris', uris },
        ctx,
    );
    assert.ok(!res.isError);
    assert.equal(log[0].method, 'replaceTracksInPlaylist');
    assert.equal((log[0].args[1] as string[]).length, 100);
    assert.equal(log[1].method, 'addTracksToPlaylist');
    assert.equal((log[1].args[1] as string[]).length, 30);
});

test('reorder_playlist_tracks passes range_length', async () => {
    const { ctx, log } = fakeApi();
    const res = await playlists.handlers.reorder_playlist_tracks(
        {
            playlist: 'Mes Favoris',
            rangeStart: 3,
            insertBefore: 0,
            rangeLength: 2,
        },
        ctx,
    );
    assert.ok(!res.isError);
    assert.deepEqual(log.at(-1), {
        method: 'reorderTracksInPlaylist',
        args: ['pl1', 3, 0, { range_length: 2 }],
    });
    const missing = await playlists.handlers.reorder_playlist_tracks(
        { playlist: 'Mes Favoris', rangeStart: 3 },
        ctx,
    );
    assert.ok(missing.isError);
});

test('delete_playlist calls unfollowPlaylist', async () => {
    const { ctx, log } = fakeApi();
    const res = await playlists.handlers.delete_playlist(
        { playlist: 'Mes Favoris' },
        ctx,
    );
    assert.ok(!res.isError);
    assert.deepEqual(log.at(-1), { method: 'unfollowPlaylist', args: ['pl1'] });
    assert.equal(parse(res).deleted, true);
});

test('create_playlist defaults to private; update_playlist_details only sends given fields', async () => {
    const { ctx, log } = fakeApi();
    const created = await playlists.handlers.create_playlist(
        { name: 'Test' },
        ctx,
    );
    assert.ok(!created.isError);
    assert.deepEqual(log.at(-1), {
        method: 'createPlaylist',
        args: ['Test', { public: false }],
    });
    assert.equal(parse(created).url, 'https://open.spotify.com/playlist/new1');

    const upd = await playlists.handlers.update_playlist_details(
        { playlist: 'Mes Favoris', description: 'Nouvelle' },
        ctx,
    );
    assert.ok(!upd.isError);
    assert.deepEqual(log.at(-1), {
        method: 'changePlaylistDetails',
        args: ['pl1', { description: 'Nouvelle' }],
    });
    const nothing = await playlists.handlers.update_playlist_details(
        { playlist: 'Mes Favoris' },
        ctx,
    );
    assert.ok(nothing.isError);
});

test('unknown playlist name is a clean error, not a throw', async () => {
    const { ctx } = fakeApi();
    const res = await playlists.handlers.delete_playlist(
        { playlist: 'Inconnue' },
        ctx,
    );
    assert.ok(res.isError);
    assert.match(
        res.content[0].text,
        /No playlist named "Inconnue" among your 1 playlists/,
    );
});

test('every tool has a handler with matching names', () => {
    const names = playlists.tools.map((t) => t.name).sort();
    assert.deepEqual(names, Object.keys(playlists.handlers).sort());
    assert.deepEqual(names, [
        'add_tracks_to_playlist',
        'create_playlist',
        'delete_playlist',
        'get_playlist_tracks',
        'remove_tracks_from_playlist',
        'reorder_playlist_tracks',
        'replace_playlist_tracks',
        'update_playlist_details',
    ]);
});
