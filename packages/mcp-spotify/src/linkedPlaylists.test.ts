import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePlaylists, type LinkedPlaylist } from './linkedPlaylists';

test('mergePlaylists: favoris en tête, doublons du compte retirés', () => {
    const linked: LinkedPlaylist[] = [
        {
            id: 'a',
            name: 'Radio Montée',
            owner: 'favori',
            uri: 'spotify:playlist:a',
            tracks: 0,
            source: 'link',
            pinned: true,
        },
        {
            id: 'b',
            name: 'Chill',
            owner: 'Jérémy',
            uri: 'spotify:playlist:b',
            tracks: 42,
            source: 'account',
            pinned: true,
        },
    ];
    const account = [
        {
            id: 'b',
            name: 'Chill',
            owner: 'Jérémy',
            uri: 'spotify:playlist:b',
            tracks: 42,
        },
        {
            id: 'c',
            name: 'Sport',
            owner: 'Jérémy',
            uri: 'spotify:playlist:c',
            tracks: 51,
        },
    ];
    const merged = mergePlaylists(linked, account);
    assert.deepEqual(
        merged.map((p) => p.name),
        ['Radio Montée', 'Chill', 'Sport'],
    );
    assert.equal((merged[1] as LinkedPlaylist).pinned, true);
    assert.equal((merged[2] as any).pinned, undefined);
});
