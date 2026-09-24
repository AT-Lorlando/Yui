import assert from 'assert';
import { normalizePalette, slugify, DEFAULT_PALETTES } from './palettes';

// Slug : accents et espaces.
assert.strictEqual(slugify('Forêt d’été'), 'foret-d-ete');

// Création : id dérivé du nom, unique face aux existantes, couleurs en majuscules.
const p = normalizePalette(
    { name: 'Forêt', colors: ['#1db954', '#0b6e4f'], brightness: 40.4 },
    DEFAULT_PALETTES,
);
assert.strictEqual(p.id, 'foret-2');
assert.deepStrictEqual(p.colors, ['#1DB954', '#0B6E4F']);
assert.strictEqual(p.brightness, 40);
assert.strictEqual(p.builtIn, undefined);

// Mise à jour d'une palette semée : garde builtIn.
const u = normalizePalette(
    { id: 'tokyo', name: 'Tokyo nuit', colors: ['#FF2D95'], brightness: 30 },
    DEFAULT_PALETTES,
);
assert.strictEqual(u.builtIn, true);
assert.strictEqual(u.name, 'Tokyo nuit');

// Validation.
assert.throws(
    () =>
        normalizePalette(
            { name: ' ', colors: ['#ffffff'], brightness: 50 },
            [],
        ),
    /nom/,
);
assert.throws(
    () => normalizePalette({ name: 'x', colors: [], brightness: 50 }, []),
    /couleur/,
);
assert.throws(
    () => normalizePalette({ name: 'x', colors: ['red'], brightness: 50 }, []),
    /invalide/,
);
assert.throws(
    () =>
        normalizePalette({ name: 'x', colors: ['#ffffff'], brightness: 0 }, []),
    /luminosité/,
);
assert.throws(
    () =>
        normalizePalette(
            { name: 'x', colors: Array(9).fill('#ffffff'), brightness: 50 },
            [],
        ),
    /maximum/,
);

console.log('All palettes tests passed');
