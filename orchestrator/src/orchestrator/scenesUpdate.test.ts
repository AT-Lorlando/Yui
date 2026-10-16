// updateScene : null efface un champ (intro/floating), undefined le laisse.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-scenes-'));
process.env.YUI_DATA_DIR = tmp;

// Import après la variable d'env : le chemin de scenes.json est résolu au chargement.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
    createScene,
    updateScene,
    getScene,
    validateFloating,
} = require('./scenes');

const created = createScene({
    name: 'Test',
    icon: 'lucide:bolt',
    color: '#000',
    description: '',
    setup: [],
    state: [],
    intro: { effectId: 'intro-1' },
    floating: null as any, // null à la création → clé absente
});
assert.strictEqual(
    'floating' in getScene(created.id),
    false,
    'null ignoré à la création',
);
assert.deepStrictEqual(getScene(created.id).intro, { effectId: 'intro-1' });

updateScene(created.id, { name: 'Test 2' });
assert.deepStrictEqual(
    getScene(created.id).intro,
    { effectId: 'intro-1' },
    'undefined ne touche pas',
);

updateScene(created.id, { intro: null as any });
assert.strictEqual(
    'intro' in getScene(created.id),
    false,
    'null efface l’intro',
);
assert.strictEqual(getScene(created.id).name, 'Test 2');

updateScene(created.id, { floating: { effectId: 'f', target: 'Salon' } });
assert.deepStrictEqual(getScene(created.id).floating, {
    effectId: 'f',
    target: 'Salon',
});
updateScene(created.id, { floating: null as any });
assert.strictEqual(
    'floating' in getScene(created.id),
    false,
    'null efface la dérive',
);

// Dérive multi-effets : { effects: [{ effectId, target }] }
const list = {
    effects: [
        { effectId: 'aurora', target: 'Salon' },
        { effectId: 'braise', target: ['Lampe Sol', 'Bureau'] },
    ],
};
updateScene(created.id, { floating: list });
assert.deepStrictEqual(getScene(created.id).floating, list);
const withList = createScene({
    name: 'Multi',
    icon: 'lucide:bolt',
    color: '#000',
    description: '',
    setup: [],
    state: [],
    floating: list,
});
assert.deepStrictEqual(getScene(withList.id).floating, list);

// Validation : liste vide / entrées invalides refusées, rien n'est écrit
assert.strictEqual(validateFloating(list), null);
assert.strictEqual(validateFloating({ effectId: 'f', target: 'Salon' }), null);
assert.strictEqual(validateFloating(undefined), null);
assert.strictEqual(validateFloating(null), null);
for (const bad of [
    { effects: [] },
    { effects: [{ effectId: '', target: 'Salon' }] },
    { effects: [{ effectId: 'a', target: '' }] },
    { effects: [{ effectId: 'a', target: [] }] },
    { effects: [{ effectId: 'a', target: ['Salon', ''] }] },
    { effects: [{ effectId: 'a' }] },
    { effects: [null] },
    { effects: [42] },
    {
        effects: Array.from({ length: 21 }, () => ({
            effectId: 'a',
            target: 'S',
        })),
    },
    { effects: 'aurora' },
    'aurora',
]) {
    assert.ok(validateFloating(bad), `refusé : ${JSON.stringify(bad)}`);
}
assert.throws(
    () => updateScene(created.id, { floating: { effects: [] } as any }),
    /floating/,
);
assert.deepStrictEqual(getScene(created.id).floating, list, 'inchangé');
assert.throws(
    () =>
        createScene({
            name: 'Bad',
            icon: 'x',
            color: '#000',
            description: '',
            setup: [],
            state: [],
            floating: { effects: [] } as any,
        }),
    /floating/,
);

// Normalisation : champs en trop retirés, espaces ôtés
updateScene(created.id, {
    floating: {
        effects: [{ effectId: ' aurora ', target: [' Salon '], foo: 1 }],
    } as any,
});
assert.deepStrictEqual(getScene(created.id).floating, {
    effects: [{ effectId: 'aurora', target: ['Salon'] }],
});
// Scène inconnue : null (404) même avec un floating invalide
assert.strictEqual(
    updateScene('inconnue', { floating: { effects: [] } as any }),
    null,
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('scenesUpdate: ok');
