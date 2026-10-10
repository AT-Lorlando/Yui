import assert from 'assert';
import { normalizeLinked, toPlaylistUri, MAX_ITEMS } from './musicPlaylists';

const ID = '37i9dQZF1DXcBWIGoYBM5M';

// Lien / URI / id → URI canonique.
assert.strictEqual(toPlaylistUri(ID), `spotify:playlist:${ID}`);
assert.strictEqual(
    toPlaylistUri(`spotify:playlist:${ID}`),
    `spotify:playlist:${ID}`,
);
assert.strictEqual(
    toPlaylistUri(`https://open.spotify.com/playlist/${ID}?si=abc`),
    `spotify:playlist:${ID}`,
);
assert.strictEqual(
    toPlaylistUri(`https://open.spotify.com/intl-fr/playlist/${ID}`),
    `spotify:playlist:${ID}`,
);
assert.strictEqual(toPlaylistUri('Radio Montée'), null);
assert.strictEqual(toPlaylistUri(`spotify:album:${ID}`), null);

// Création : id dérivé du nom, source lien par défaut, champs optionnels filtrés.
const a = normalizeLinked(
    {
        name: 'Radio Montée',
        uri: `https://open.spotify.com/playlist/${ID}`,
        image: 'javascript:x',
    },
    [],
    1000,
);
assert.deepStrictEqual(a, {
    id: 'radio-montee',
    name: 'Radio Montée',
    uri: `spotify:playlist:${ID}`,
    source: 'link',
    addedAt: 1000,
});

// Doublon par uri refusé ; renommage de la même entrée accepté (garde source/addedAt).
assert.throws(
    () => normalizeLinked({ name: 'Autre', uri: ID }, [a]),
    /déjà dans les favoris : Radio Montée/,
);
const renamed = normalizeLinked(
    { id: a.id, name: 'Radio Montée (soir)', uri: a.uri },
    [a],
    2000,
);
assert.strictEqual(renamed.addedAt, 1000);
assert.strictEqual(renamed.source, 'link');
assert.strictEqual(renamed.name, 'Radio Montée (soir)');

// Épingle du compte : source account, owner/image/tracks conservés.
const b = normalizeLinked(
    {
        name: 'Chill du soir',
        uri: 'spotify:playlist:6ZaYklBUR7Tie7Lsab3FfD',
        source: 'account',
        owner: 'Jérémy',
        image: 'https://i.scdn.co/x.jpg',
        tracks: 42,
    },
    [a],
);
assert.strictEqual(b.source, 'account');
assert.strictEqual(b.tracks, 42);
assert.strictEqual(b.image, 'https://i.scdn.co/x.jpg');

// Validation.
assert.throws(() => normalizeLinked({ name: '', uri: ID }, []), /nom requis/);
assert.throws(
    () => normalizeLinked({ name: 'x', uri: 'nope' }, []),
    /lien Spotify invalide/,
);
assert.throws(
    () => normalizeLinked({ name: 'x'.repeat(81), uri: ID }, []),
    /trop long/,
);
const many = Array.from({ length: MAX_ITEMS }, (_, i) => ({
    ...a,
    id: `p${i}`,
    uri: `spotify:playlist:${String(i).padStart(22, '0')}`,
}));
assert.throws(
    () => normalizeLinked({ name: 'trop', uri: ID }, many),
    /maximum/,
);

// Ids uniques quand deux noms se ressemblent.
const c = normalizeLinked(
    { name: 'Radio Montee', uri: 'spotify:playlist:0000000000000000000000' },
    [a],
);
assert.strictEqual(c.id, 'radio-montee-2');

console.log('musicPlaylists: ok');
